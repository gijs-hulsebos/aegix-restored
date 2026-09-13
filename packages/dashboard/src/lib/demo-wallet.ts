import {BaseMessageSignerWalletAdapter,WalletReadyState,type WalletName} from '@solana/wallet-adapter-base';
import {PublicKey,Transaction,VersionedTransaction} from '@solana/web3.js';
export class DemoWalletAdapter extends BaseMessageSignerWalletAdapter {
  name='Aegix Demo' as WalletName;url='https://localhost';icon='data:image/svg+xml;base64,PHN2Zy8+' as const;
  readyState=WalletReadyState.Installed;supportedTransactionVersions=null;
  publicKey:PublicKey|null=null;connecting=false;
  async connect(){await new Promise(resolve=>setTimeout(resolve,0));this.publicKey=new PublicKey('11111111111111111111111111111111');this.emit('connect',this.publicKey);}
  async disconnect(){this.publicKey=null;this.emit('disconnect');}
  async signMessage(){return new Uint8Array(64);}
  async signTransaction<T extends Transaction|VersionedTransaction>(_transaction:T):Promise<T>{throw Error('Demo cannot sign or send blockchain transactions');}
}
