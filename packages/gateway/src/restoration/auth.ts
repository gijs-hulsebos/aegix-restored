import { randomBytes, createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import type { Express, Request, Response, NextFunction } from 'express';
import { mode, verifyNetwork } from './network.js';
import vaultFs from './vault-fs.js';
import path from 'node:path';

const sessions = new Map<string,{owner:string;until:number}>();
const challenges = new Map<string,{message:string;owner:string;until:number}>();
const journalFile = path.resolve(process.env.AEGIX_DATA_DIR!, 'request-journal.json');
const journal: Record<string,{hash:string;status:number;result:unknown}> = vaultFs.existsSync(journalFile) ? JSON.parse(vaultFs.readFileSync(journalFile,'utf8')) : {};
function persist() { vaultFs.writeFileSync(journalFile,JSON.stringify(journal)); }
function verify(owner:string,message:string,signature:string) {
  try { return nacl.sign.detached.verify(Buffer.from(message),Buffer.from(signature,'base64'),new PublicKey(owner).toBytes()); } catch { return false; }
}
export function installAuth(app:Express, lookup:(kind:string,id:string)=>string|undefined) {
  app.post('/auth/challenge',(req,res)=>{
    try { new PublicKey(req.body.owner); } catch { res.status(400).json({success:false,error:'Invalid owner'});return; }
    const now=Date.now();for(const [k,v] of challenges)if(v.until<now)challenges.delete(k);
    if(challenges.size>1000){res.status(429).end();return;}
    const nonce=randomBytes(24).toString('hex');
    const message=`Aegix: authorize local session\nNetwork: ${mode}\nWallet: ${req.body.owner}\nChallenge: ${nonce}\nExpires: ${now+120000}`;
    challenges.set(nonce,{owner:req.body.owner,message,until:now+120000});res.json({nonce,message});
  });
  app.post('/auth/session',(req,res)=>{
    const c=challenges.get(req.body.nonce);challenges.delete(req.body.nonce);
    if(!c||c.until<Date.now()||!verify(c.owner,c.message,req.body.signature)){res.status(401).json({success:false,error:'Invalid wallet proof'});return;}
    const token=randomBytes(32).toString('hex');sessions.set(token,{owner:c.owner,until:Date.now()+30*60*1000});res.json({token,owner:c.owner});
  });
  app.use('/api',async(req:Request,res:Response,next:NextFunction)=>{
    const publicRead=req.method==='GET' && ['/status','/credits/resources','/agents/light/health','/payai/health','/credits/stealth/stats','/credits/light/estimate'].includes(req.path);
    if(publicRead){next();return;}
    const token=req.get('authorization')?.replace(/^Bearer /,'');const session=token?sessions.get(token):undefined;
    if(!session||session.until<Date.now()){res.status(401).json({success:false,error:'Connect your wallet and authorize this session'});return;}
    const owner=session.owner;
    const inputs={...req.query,...req.body};
    if(inputs.owner && inputs.owner!==owner){res.status(403).json({success:false,error:'Wallet owner mismatch'});return;}
    for(const name of ['agentId','poolId','fromPoolId','toPoolId']) {
      if(inputs[name]){const actual=lookup(name==='agentId'?'agent':'pool',String(inputs[name]));if(actual && actual!==owner){res.status(403).json({success:false,error:'Resource belongs to another wallet'});return;}}
    }
    const parts=req.path.split('/').filter(Boolean);
    const resourceOwner=parts[0]==='agents'?(parts[1]==='pools'?lookup('pool',parts[2]):lookup('agent',parts[1])):undefined;
    if(resourceOwner&&resourceOwner!==owner){res.status(403).json({success:false,error:'Resource belongs to another wallet'});return;}
    // Owner-address routes must not expose another wallet's private history/pools.
    const tail=parts[parts.length-1];
    try { new PublicKey(tail);if(tail!==owner){res.status(403).json({success:false,error:'Wallet owner mismatch'});return;} } catch {}
    if(['GET','HEAD'].includes(req.method)){next();return;}
    const nonce=req.get('x-aegix-nonce')??'',time=Number(req.get('x-aegix-time'));
    const body=JSON.stringify(req.body??{});
    const digest=createHash('sha256').update(body).digest('hex');
    const requestPath=req.originalUrl;
    const message=`Aegix transaction authorization\nNetwork: ${mode}\nWallet: ${owner}\nRequest: ${req.method} ${requestPath}\nBody: ${body}\nTime: ${time}\nNonce: ${nonce}`;
    if(!/^[a-f0-9-]{20,64}$/.test(nonce)||Math.abs(Date.now()-time)>120000||!verify(owner,message,req.get('x-aegix-signature')??'')){res.status(401).json({success:false,error:'Fresh authorization required for this exact operation'});return;}
    const key=owner+':'+nonce;const requestHash=createHash('sha256').update(req.method+requestPath+digest).digest('hex');
    if(journal[key]){const old=journal[key];if(old.hash!==requestHash){res.status(409).json({success:false,error:'Authorization reused for a different request'});return;}res.status(old.status).json(old.result);return;}
    try { await verifyNetwork(); } catch {res.status(503).json({success:false,error:'Configured network could not be verified'});return;}
    if(journal[key]){const old=journal[key];res.status(old.status).json(old.result);return;}
    journal[key]={hash:requestHash,status:409,result:{success:false,error:'Operation already started; check its outcome before retrying',errorCode:'OUTCOME_UNKNOWN'}};persist();
    const originalJson=res.json.bind(res);
    res.json=((value:unknown)=>{journal[key]={hash:requestHash,status:res.statusCode,result:value};persist();return originalJson(value);}) as typeof res.json;
    next();
  });
}
