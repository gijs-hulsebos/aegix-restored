import {Connection,Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {getAssociatedTokenAddress,createTransferCheckedInstruction} from '@solana/spl-token';
import {createHash} from 'node:crypto';
import path from 'node:path';
import vault from '../restoration/vault-fs.js';
const base=process.env.FACILITATOR_URL||'https://facilitator.payai.network';
const network=process.env.AEGIX_MODE==='mainnet'?'solana':'solana-devnet';
export async function getPayAISupport(){
 const r=await fetch(base+'/supported',{signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`PayAI discovery HTTP ${r.status}`);
 const j=await r.json();const kind=j.kinds?.find((k:any)=>k.x402Version===1&&k.scheme==='exact'&&k.network===network);
 if(!kind?.extra?.feePayer)throw Error(`PayAI does not advertise exact v1 for ${network}`);
 return {network,feePayer:String(kind.extra.feePayer)};
}
export async function settlePayAITransfer(connection:Connection,owner:Keypair,recipient:string,amount:bigint){
 let submitted=false;let feePayer:string|undefined;
 try{
  const supported=await getPayAISupport();feePayer=supported.feePayer;
  const mint=new PublicKey(process.env.USDC_MINT!),to=new PublicKey(recipient);
  const source=await getAssociatedTokenAddress(mint,owner.publicKey),destination=await getAssociatedTokenAddress(mint,to);
  const latest=await connection.getLatestBlockhash('confirmed');
  const message=new TransactionMessage({payerKey:new PublicKey(feePayer),recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:8000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}),createTransferCheckedInstruction(source,mint,destination,owner.publicKey,amount,6)]}).compileToV0Message();
  const tx=new VersionedTransaction(message);tx.sign([owner]);
  const body={x402Version:1,paymentPayload:{x402Version:1,scheme:'exact',network,payload:{transaction:Buffer.from(tx.serialize()).toString('base64')}},paymentRequirements:{scheme:'exact',network,maxAmountRequired:amount.toString(),resource:'https://aegix.local/payments',description:'Aegix burner payment',mimeType:'application/json',payTo:recipient,maxTimeoutSeconds:120,asset:mint.toBase58(),extra:{feePayer}}};
  const raw=JSON.stringify(body),id=createHash('sha256').update(raw).digest('hex');
  const verifyResponse=await fetch(base+'/verify',{method:'POST',headers:{'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(20000)});
  const verification=await verifyResponse.json();
  if(!verifyResponse.ok||!verification.isValid)return {success:false,error:`PayAI verification rejected: ${verification.invalidReason||verifyResponse.status} ${verification.invalidMessage||''}`,feePayer,phase:'verification'};
  const file=path.join(process.env.AEGIX_DATA_DIR!,'payai',id+'.json');
  vault.writeFileSync(file,JSON.stringify({body,network,owner:owner.publicKey.toBase58(),recipient,amount:amount.toString(),lastValidBlockHeight:latest.lastValidBlockHeight,phase:'submitting'}));
  submitted=true;
  const r=await fetch(base+'/settle',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':id},body:raw,signal:AbortSignal.timeout(60000)});
  const result=await r.json();vault.writeFileSync(file,JSON.stringify({body,network,owner:owner.publicKey.toBase58(),recipient,amount:amount.toString(),lastValidBlockHeight:latest.lastValidBlockHeight,phase:'response',result}));
  if(!result.success||!result.transaction)return {success:false,error:`PayAI settlement: ${result.errorReason||r.status} ${result.errorMessage||''}`,feePayer,phase:'settlement',settlementId:id};
  const confirmation=await connection.confirmTransaction({...latest,signature:result.transaction},'confirmed');
  if(confirmation.value.err)throw Error('PayAI transaction failed on chain');
  return {success:true,txSignature:String(result.transaction),feePayer,phase:'confirmed',settlementId:id};
 }catch(e:any){return {success:false,error:`PayAI ${submitted?'settlement outcome pending; keep the original request':'verification unavailable'}: ${e.message}`,feePayer,phase:submitted?'pending':'verification'};}
}
