'use client';
import { useEffect,useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { currentMode,setOriginalSigner,type OriginalMode } from '@/lib/original-runtime';
export function OriginalRuntime(){
  const {publicKey,signMessage,select,wallet,connected,connect}=useWallet();const [mode,setMode]=useState<OriginalMode>('devnet');
  useEffect(()=>{setMode(currentMode());},[]);
  useEffect(()=>{if(currentMode()!=='demo')return;if(wallet?.adapter.name!=='Aegix Demo'){select('Aegix Demo' as any);return;}if(!connected)void connect().catch(()=>{});},[wallet,connected,connect,select]);
  const address=publicKey?.toBase58()||'';
  useEffect(()=>{setOriginalSigner(address,signMessage);},[address,signMessage]);
  return <div data-wallet={wallet?.adapter.name} data-connected={String(connected)} className="fixed bottom-3 left-3 z-[100] border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs font-mono text-slate-300 flex items-center gap-3"><span>NETWORK</span><select aria-label="Aegix network" value={mode} className="bg-slate-900 text-cyan-300 border border-slate-700 px-2 py-1" onChange={e=>{document.cookie=`aegix-mode=${e.target.value};path=/;SameSite=Strict`;window.location.reload();}}><option value="demo">DEMO · no blockchain</option><option value="devnet">DEVNET · test funds</option><option value="mainnet">MAINNET · real funds</option></select></div>;
}

