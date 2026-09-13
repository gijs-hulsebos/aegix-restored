import type {Connection} from '@solana/web3.js';
export async function verifyPoolFunding(connection:Connection,signature:string,owner:string,pool:string){
  const tx=await connection.getParsedTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  if(!tx?.meta||tx.meta.err)throw Error('Funding is not confirmed');
  const keys=tx.transaction.message.accountKeys;
  if(!keys.some(k=>k.signer&&k.pubkey.toBase58()===owner))throw Error('Funding signer does not match owner');
  const balance=(entries:any[])=>entries.filter(e=>e.owner===pool&&e.mint===process.env.USDC_MINT).reduce((sum,e)=>sum+BigInt(e.uiTokenAmount.amount),0n);
  const tokenIncrease=balance(tx.meta.postTokenBalances||[])-balance(tx.meta.preTokenBalances||[]);
  const index=keys.findIndex(k=>k.pubkey.toBase58()===pool);
  const solIncrease=index>=0?tx.meta.postBalances[index]-tx.meta.preBalances[index]:0;
  if(tokenIncrease<=0n&&solIncrease<=0)throw Error('Transaction did not fund this pool');
}
