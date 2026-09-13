import type {Connection} from '@solana/web3.js';
export async function confirmSignature(connection:Connection,strategy:any,_commitment?:any){
  const signature=typeof strategy==='string'?strategy:strategy.signature;
  for(let attempt=0;attempt<30;attempt++){
    const result=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true});const status=result.value[0];
    if(status&&['confirmed','finalized'].includes(status.confirmationStatus||'')){if(status.err)throw Error('Transaction failed on chain');return {value:{err:null}};}
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  throw Error('Transaction outcome is not yet known. Check the existing signature before retrying.');
}
