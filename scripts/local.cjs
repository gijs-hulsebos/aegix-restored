const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const build=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc')],{cwd:path.join(root,'packages/gateway'),stdio:'inherit',windowsHide:true});if(build.status!==0)process.exit(build.status||1);
const envFile=path.join(root,'.env.local');
if(!fs.existsSync(envFile))fs.writeFileSync(envFile,'AEGIX_STORAGE_KEY='+crypto.randomBytes(32).toString('hex')+'\n',{mode:0o600});
const local=require('dotenv').parse(fs.readFileSync(envFile));
// A single Helius key provides separate cluster URLs; explicit endpoints take priority.
if(local.HELIUS_API_KEY){
  for(const network of ['DEVNET','MAINNET']){
    const rpc='https://'+network.toLowerCase()+'.helius-rpc.com/?api-key='+encodeURIComponent(local.HELIUS_API_KEY);
    local['AEGIX_'+network+'_RPC'] ||= rpc;
    local['AEGIX_'+network+'_LIGHT_RPC'] ||= rpc;
  }
}
if(!/^[a-f0-9]{64}$/i.test(local.AEGIX_STORAGE_KEY||''))throw Error('Local storage key missing');
const children=[];
for(const [mode,port] of [['devnet','3701'],['mainnet','3703'],['demo','3705']]){
  const secret=crypto.createHash('sha256').update(local.AEGIX_STORAGE_KEY+mode).digest('hex');
  children.push(spawn(process.execPath,['dist/start.js'],{cwd:path.join(root,'packages/gateway'),stdio:'inherit',windowsHide:true,env:{...process.env,...local,AEGIX_MODE:mode,PORT:port,AEGIX_STORAGE_KEY:secret,SESSION_KEY_SECRET:secret,INCO_BYTES_KEY:secret,AEGIX_DATA_DIR:path.join(root,'packages/gateway/data',mode),SOLANA_RPC_URL:local[mode==='mainnet'?'AEGIX_MAINNET_RPC':'AEGIX_DEVNET_RPC']||(mode==='mainnet'?'https://api.mainnet-beta.solana.com':'https://api.devnet.solana.com'),LIGHT_RPC_URL:local[mode==='mainnet'?'AEGIX_MAINNET_LIGHT_RPC':'AEGIX_DEVNET_LIGHT_RPC']||''}}));
}
children.push(spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','-H','127.0.0.1','-p','3500'],{cwd:path.join(root,'packages/dashboard'),stdio:'inherit',windowsHide:true,env:{...process.env,...local,NEXT_TELEMETRY_DISABLED:'1'}}));
let stopping=false;function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
for(const child of children)child.on('error',stop);
console.log('ORIGINAL AEGIX: http://127.0.0.1:3500/landing — original dashboard at /');
