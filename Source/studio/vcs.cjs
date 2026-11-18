'use strict';
// 项目版本控制：优先使用本机 git；没有 git 时退化为工作站内置快照（清单 + 文本文件副本）。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFile} = require('node:child_process');

function git(args, cwd, timeout=120000){
  return new Promise(resolve=>execFile('git', args, {cwd, timeout, windowsHide:true, maxBuffer:8*1024*1024, encoding:'utf8'},
    (err, stdout, stderr)=>resolve({ok:!err, code:err?.code??0, stdout:stdout||'', stderr:stderr||(err?err.message:'')})));
}
async function available(){ const r = await git(['--version'], process.cwd(), 10000); return r.ok ? r.stdout.trim() : null; }

const IGNORE = ['Intermediate/','Saved/','Binaries/','DerivedDataCache/','Build/','node_modules/','*.pdb','*.obj','*.exe','*.dll','.aigw/jobs/','Packaged/','*.tmp'];
async function init(root){
  const v = await available(); if(!v) throw Error('本机未安装 git；可使用内置快照代替。');
  const gi = path.join(root, '.gitignore');
  if(!fs.existsSync(gi)) fs.writeFileSync(gi, IGNORE.join('\n')+'\n', 'utf8');
  if(fs.existsSync(path.join(root, '.git'))) return {already:true, version:v};
  const r = await git(['init','-b','main'], root); if(!r.ok) throw Error('git init 失败：'+r.stderr);
  return {already:false, version:v, output:r.stdout};
}
async function status(root){
  if(!fs.existsSync(path.join(root,'.git'))) return {repo:false, files:[]};
  const r = await git(['status','--porcelain','-uall'], root);
  const files = r.stdout.split(/\r?\n/).filter(Boolean).slice(0,400).map(l=>({state:l.slice(0,2).trim(), path:l.slice(3)}));
  const branch = (await git(['rev-parse','--abbrev-ref','HEAD'], root)).stdout.trim();
  return {repo:true, branch, files, dirty:files.length>0};
}
async function commit(root, message){
  if(!fs.existsSync(path.join(root,'.git'))) await init(root);
  if(!message || message.length>500) throw Error('请提供 1–500 字的提交说明');
  await git(['add','-A'], root, 300000);
  const r = await git(['-c','user.name=AI Game Workstation','-c','user.email=aigw@local','commit','-m',message], root, 300000);
  if(!r.ok && !/nothing to commit/i.test(r.stdout+r.stderr)) throw Error('提交失败：'+(r.stderr||r.stdout));
  const head = (await git(['rev-parse','--short','HEAD'], root)).stdout.trim();
  return {commit:head, message, nothing:/nothing to commit/i.test(r.stdout)};
}
async function log(root, limit=25){
  if(!fs.existsSync(path.join(root,'.git'))) return [];
  const r = await git(['log','-n',String(limit),'--pretty=format:%h|%ad|%s','--date=iso'], root);
  return r.stdout.split(/\r?\n/).filter(Boolean).map(l=>{ const [hash,date,...s]=l.split('|'); return {hash, date, subject:s.join('|')}; });
}
async function restore(root, file){ const r = await git(['checkout','--','file'===file?file:file], root); if(!r.ok) throw Error('还原失败：'+r.stderr); return true; }

// ---- 内置快照（无 git 时） ----
const TEXT = /\.(cs|cpp|h|hpp|py|js|json|ini|md|txt|uproject|uplugin|yaml|yml)$/i;
function snapshotDir(root){ return path.join(root, '.aigw', 'snapshots'); }
function scan(root){
  const out = []; const skip = new Set(['Intermediate','Saved','Binaries','DerivedDataCache','node_modules','.git','.aigw','Packaged','Build']);
  const walk = (d, depth)=>{ if(depth>8) return; let es; try{ es = fs.readdirSync(d,{withFileTypes:true}); }catch{ return; }
    for(const e of es){ if(e.name.startsWith('.')&&e.name!=='.gitignore') continue; const f = path.join(d, e.name);
      if(e.isDirectory()){ if(!skip.has(e.name)) walk(f, depth+1); }
      else if(e.isFile()){ try{ const s = fs.statSync(f); if(s.size>20*1024*1024) continue; out.push({path:path.relative(root,f), bytes:s.size, mtime:s.mtime.toISOString(), hash:crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0,16)}); }catch{} } } };
  walk(root, 0); return out;
}
function snapshot(root, label){
  const id = new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,6);
  const dir = path.join(snapshotDir(root), id); fs.mkdirSync(path.join(dir,'files'), {recursive:true});
  const files = scan(root); let copied = 0;
  for(const f of files) if(TEXT.test(f.path) && f.bytes < 2*1024*1024){
    const dest = path.join(dir, 'files', f.path); fs.mkdirSync(path.dirname(dest), {recursive:true});
    try{ fs.copyFileSync(path.join(root, f.path), dest); copied++; }catch{}
  }
  const manifest = {id, label:String(label||'快照').slice(0,200), createdAt:new Date().toISOString(), fileCount:files.length, textCopied:copied, files};
  fs.writeFileSync(path.join(dir,'manifest.json'), JSON.stringify(manifest,null,2), 'utf8');
  return {id, label:manifest.label, createdAt:manifest.createdAt, fileCount:files.length, textCopied:copied};
}
function snapshots(root){
  const dir = snapshotDir(root); if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(id=>{ try{ const m = JSON.parse(fs.readFileSync(path.join(dir,id,'manifest.json'),'utf8')); return {id:m.id, label:m.label, createdAt:m.createdAt, fileCount:m.fileCount, textCopied:m.textCopied}; }catch{ return null; } })
    .filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
}
function diff(root, id){
  const m = JSON.parse(fs.readFileSync(path.join(snapshotDir(root), id, 'manifest.json'),'utf8'));
  const now = new Map(scan(root).map(f=>[f.path,f])); const before = new Map(m.files.map(f=>[f.path,f]));
  const added = [...now.keys()].filter(p=>!before.has(p)); const removed = [...before.keys()].filter(p=>!now.has(p));
  const changed = [...now.keys()].filter(p=>before.has(p)&&before.get(p).hash!==now.get(p).hash);
  return {id, label:m.label, createdAt:m.createdAt, added:added.slice(0,200), removed:removed.slice(0,200), changed:changed.slice(0,200), counts:{added:added.length, removed:removed.length, changed:changed.length}};
}
function restoreFile(root, id, relPath){
  const src = path.join(snapshotDir(root), id, 'files', relPath);
  if(!fs.existsSync(src)) throw Error('快照中没有该文件的文本副本：'+relPath);
  const dest = path.join(root, relPath); fs.mkdirSync(path.dirname(dest), {recursive:true});
  fs.copyFileSync(dest, dest+'.before-restore', fs.constants.COPYFILE_EXCL ? 0 : 0);
  fs.copyFileSync(src, dest); return {restored:relPath};
}
module.exports = {available, init, status, commit, log, restore, snapshot, snapshots, diff, restoreFile, scan};
