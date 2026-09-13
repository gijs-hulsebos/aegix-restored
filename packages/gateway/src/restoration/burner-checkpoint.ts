import type {Keypair} from '@solana/web3.js';
import path from 'node:path';
import fs from './vault-fs.js';
export function checkpointBurner(keypair:Keypair,parent:string){
  const file=path.join(process.env.AEGIX_DATA_DIR!,'burners',keypair.publicKey.toBase58()+'.json');
  fs.writeFileSync(file,JSON.stringify({publicKey:keypair.publicKey.toBase58(),parent,secretKey:Array.from(keypair.secretKey),createdAt:new Date().toISOString(),network:process.env.SOLANA_NETWORK}));
}
