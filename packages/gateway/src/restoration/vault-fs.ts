import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const secret = process.env.AEGIX_STORAGE_KEY;
if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw Error('AEGIX_STORAGE_KEY required');
const key = Buffer.from(secret, 'hex');
function encode(text: string) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
  const data = Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return JSON.stringify({format:'aegix-vault-v1',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
}
function decode(text: string) {
  const value = JSON.parse(text);
  if (value.format !== 'aegix-vault-v1') throw Error('Unencrypted historical data needs explicit migration');
  const decipher = crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));
  decipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString('utf8');
}
const vaultFs = { ...fs,
  readFileSync: ((file: any, options?: any) => {
    if (typeof file !== 'string' || !file.endsWith('.json')) return fs.readFileSync(file,options);
    const text = decode(fs.readFileSync(file,'utf8'));
    return typeof options === 'string' || options?.encoding ? text : Buffer.from(text);
  }) as typeof fs.readFileSync,
  writeFileSync: ((file: any, data: any, options?: any) => {
    if (typeof file !== 'string' || !file.endsWith('.json')) return fs.writeFileSync(file,data,options);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file+'.tmp',encode(String(data)),{mode:0o600});fs.renameSync(file+'.tmp',file);
  }) as typeof fs.writeFileSync,
};
export default vaultFs;
