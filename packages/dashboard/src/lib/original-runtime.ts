export type OriginalMode = 'demo' | 'devnet' | 'mainnet';
export function originalRpcEndpoint():string {
  return typeof window === 'undefined' ? 'https://api.devnet.solana.com' : window.location.origin + '/api/rpc';
}
export function currentMode():OriginalMode {
  if(typeof document==='undefined') return 'devnet';
  const value=document.cookie.split('; ').find(s=>s.startsWith('aegix-mode='))?.split('=')[1];
  return value==='demo'||value==='mainnet'?value:'devnet';
}
type Signer=(message:Uint8Array)=>Promise<Uint8Array>;
let owner='',signer:Signer|undefined,token='',sessionPromise:Promise<string>|undefined;
const nativeFetch = (...args:Parameters<typeof fetch>)=>globalThis.fetch(...args);
export function setOriginalSigner(address:string,fn:Signer|undefined){if(owner!==address){token='';sessionPromise=undefined;}owner=address;signer=fn;}
async function session(){
  if(token)return token;
  if(sessionPromise)return sessionPromise;
  if(!owner||!signer)throw Error('Connect your wallet to access your Aegix pool');
  sessionPromise=(async()=>{
    const challengeResponse=await nativeFetch('/api/gateway/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner})});
    const challenge=await challengeResponse.json();
    if(!challengeResponse.ok || typeof challenge.message !== 'string' || !challenge.message.trim() || typeof challenge.nonce !== 'string') throw Error(challenge.error || 'The gateway did not return a valid signing challenge');
    const signed=await signer!(new TextEncoder().encode(challenge.message));
    const result=await nativeFetch('/api/gateway/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:challenge.nonce,signature:btoa(String.fromCharCode(...Array.from(signed)))})}).then(r=>r.json());
    if(!result.token)throw Error(result.error||'Wallet authorization failed');token=result.token;return token;
  })();
  try{return await sessionPromise;}finally{sessionPromise=undefined;}
}
export async function originalFetch(input:RequestInfo|URL,init:RequestInit={}){
  const url=typeof input==='string'?input:String(input);
  if(!url.startsWith('/api/gateway'))return nativeFetch(input,init);
  if(currentMode()==='demo')return nativeFetch(input,init);
  const method=(init.method||'GET').toUpperCase();
  const publicRead=method==='GET'&&['/health','/api/status','/api/credits/resources','/api/agents/light/health','/api/credits/stealth/stats','/api/credits/light/estimate'].some(p=>url==='/api/gateway'+p);
  if(publicRead)return nativeFetch(input,init);
  const headers=new Headers(init.headers);headers.set('Authorization','Bearer '+await session());
  let operationKey='';
  if(!['GET','HEAD'].includes(method)){
    const body=JSON.stringify(init.body?JSON.parse(String(init.body)):{});
    const apiPath=url.slice('/api/gateway'.length);
    operationKey='aegix-operation:'+currentMode()+':'+owner+':'+method+':'+apiPath+':'+body;
    const nonce=localStorage.getItem(operationKey)||crypto.randomUUID();localStorage.setItem(operationKey,nonce);
    const time=Date.now();
    const message=`Aegix transaction authorization\nNetwork: ${currentMode()}\nWallet: ${owner}\nRequest: ${method} ${apiPath}\nBody: ${body}\nTime: ${time}\nNonce: ${nonce}`;
    const signature=await signer!(new TextEncoder().encode(message));
    headers.set('x-aegix-nonce',nonce);headers.set('x-aegix-time',String(time));headers.set('x-aegix-signature',btoa(String.fromCharCode(...Array.from(signature))));
  }
  const response=await nativeFetch(input,{...init,headers});
  if(response.status===401)token='';
  if(operationKey){const result=await response.clone().json().catch(()=>null);if(result?.success || ['FUNDING_SIMULATION_FAILED','RECOVERED_RETRY_AVAILABLE'].includes(result?.errorCode))localStorage.removeItem(operationKey);}
  return response;
}

