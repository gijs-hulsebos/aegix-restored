import type { Connection } from '@solana/web3.js';
export async function confirmChecked(connection:Connection, strategy:any, commitment:any='confirmed') {
  const result=await connection.confirmTransaction(strategy,commitment);
  if(result.value.err) throw new Error('Transaction execution failed on chain');
  return result;
}
