import {NextRequest} from 'next/server';
export async function POST(request:NextRequest){
  const mode=request.cookies.get('aegix-mode')?.value||'devnet';
  if(mode==='demo')return Response.json({error:'No blockchain in demo'},{status:409});
  const body=await request.json();
  const allowed=['getLatestBlockhash','getSignatureStatuses','getBlockHeight','getBalance','getAccountInfo','getMultipleAccounts','getTokenAccountsByOwner','getFeeForMessage','getMinimumBalanceForRentExemption','simulateTransaction','sendTransaction','getGenesisHash','getTransaction','getSlot','getVersion'];
  if(!allowed.includes(body.method))return Response.json({error:'RPC method unavailable'},{status:400});
  const rpc=mode==='mainnet'?(process.env.AEGIX_MAINNET_RPC||'https://api.mainnet-beta.solana.com'):(process.env.AEGIX_DEVNET_RPC||'https://api.devnet.solana.com');
  try{const r=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return new Response(await r.text(),{status:r.status,headers:{'content-type':'application/json'}});}catch{return Response.json({error:{code:-32000,message:'RPC unavailable'},id:body.id,jsonrpc:'2.0'},{status:503});}
}
