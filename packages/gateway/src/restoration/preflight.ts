import {Connection, Transaction, VersionedTransaction} from '@solana/web3.js';

/** Check the exact unsigned transaction on the server's selected cluster. */
export async function simulateUnsigned(connection:Connection, transaction:Transaction) {
  const result = await connection.simulateTransaction(
    new VersionedTransaction(transaction.compileMessage()),
    {sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed'},
  );
  return {error:result.value.err,logs:result.value.logs??[],unitsConsumed:result.value.unitsConsumed};
}
