import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config();
const mode = process.env.AEGIX_MODE ?? 'devnet';
process.env.AEGIX_MODE = mode;
process.env.SOLANA_NETWORK = mode === 'mainnet' ? 'mainnet-beta' : 'devnet';
process.env.SOLANA_RPC_URL ||= mode === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
process.env.USDC_MINT = mode === 'mainnet' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : (process.env.AEGIX_TEST_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
process.env.PAYAI_NETWORK = mode === 'mainnet' ? 'solana' : 'solana-devnet';
process.env.AEGIX_DATA_DIR ||= path.resolve('data', mode);
if (mode === 'demo') await import('./restoration/demo.js');
else {
  const { verifyNetwork } = await import('./restoration/network.js');
  await verifyNetwork();
  await import('./index.js');
}
