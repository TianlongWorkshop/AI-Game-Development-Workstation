'use strict';
// 密钥库：每个供应商一个密钥，整体使用 Windows DPAPI（Electron safeStorage）加密保存。
const fs = require('node:fs'), path = require('node:path');
class Vault {
  constructor(dataRoot, safe){
    this.file = path.join(dataRoot, 'provider-keys.bin'); this.safe = safe; this.keys = {};
    if(fs.existsSync(this.file)){ try{ this.keys = JSON.parse(this.decode(fs.readFileSync(this.file))); }catch{ this.keys = {}; this.corrupt = true; } }
    const legacy = path.join(dataRoot, 'credential.bin');
    if(!this.keys.deepseek && fs.existsSync(legacy)){ try{ this.keys.deepseek = this.decode(fs.readFileSync(legacy)); this.persist(); }catch{} }
  }
  decode(buf){ return this.safe?.isEncryptionAvailable?.() ? this.safe.decryptString(buf) : buf.toString('utf8'); }
  encode(str){ if(!this.safe?.isEncryptionAvailable?.()){ if(process.env.AIGW_TEST_PLAIN_VAULT==='1') return Buffer.from(str,'utf8'); throw Error('系统加密不可用，拒绝明文保存密钥'); } return this.safe.encryptString(str); }
  persist(){ const tmp = this.file+'.tmp'; fs.writeFileSync(tmp, this.encode(JSON.stringify(this.keys))); fs.renameSync(tmp, this.file); }
  get(id){ return this.keys[id] || process.env['AIGW_KEY_'+String(id).toUpperCase()] || ''; }
  set(id, key){ key = String(key||'').trim(); if(!key){ delete this.keys[id]; } else { if(key.length<8||key.length>2000) throw Error('密钥长度无效'); this.keys[id] = key; } this.persist(); }
  list(){ return Object.keys(this.keys); }
}
module.exports = {Vault};
