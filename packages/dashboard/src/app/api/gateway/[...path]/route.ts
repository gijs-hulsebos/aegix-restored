import { NextRequest } from 'next/server';
export const dynamic='force-dynamic';
async function handle(request:NextRequest,{params}:{params:{path:string[]}}){
  const mode=request.cookies.get('aegix-mode')?.value||'devnet';
  const port=mode==='mainnet'?3703:mode==='demo'?3705:3701;
  const pathname=params.path.map(encodeURIComponent).join('/');
  const headers=new Headers();for(const key of ['content-type','authorization','x-aegix-nonce','x-aegix-time','x-aegix-signature']){const value=request.headers.get(key);if(value)headers.set(key,value);}
  try {const response=await fetch(`http://127.0.0.1:${port}/${pathname}${request.nextUrl.search}`,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.text(),cache:'no-store',signal:AbortSignal.timeout(120000)});return new Response(await response.text(),{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
  catch{return Response.json({success:false,error:'The selected Aegix backend is unavailable. No outcome is implied; check pending transactions before retrying.'},{status:503});}
}
export {handle as GET,handle as POST,handle as PUT,handle as DELETE,handle as PATCH};
