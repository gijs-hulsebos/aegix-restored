import { Connection } from '@solana/web3.js';
export const mode = process.env.AEGIX_MODE ?? 'devnet';
if (!['demo','devnet','mainnet'].includes(mode)) throw Error('Invalid AEGIX_MODE');
export const cluster = mode === 'mainnet' ? 'mainnet-beta' : 'devnet';
export const mint = mode === 'mainnet' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : (process.env.AEGIX_TEST_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
if (mode === 'mainnet' && process.env.AEGIX_TEST_MINT) throw Error('Test mint forbidden on mainnet');
export async function verifyNetwork() {
  if (mode === 'demo') return;
  const expected = mode === 'mainnet' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  for (const rpc of [...new Set([process.env.SOLANA_RPC_URL, process.env.LIGHT_RPC_URL].filter(Boolean))]) {
    const connection = new Connection(rpc!, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: (url,init) => fetch(url,{...init,signal:AbortSignal.timeout(12000)}) });
    if (await connection.getGenesisHash() !== expected) throw Error('RPC network mismatch');
  }
}
