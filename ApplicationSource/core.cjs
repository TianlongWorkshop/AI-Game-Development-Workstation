'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runFile = promisify(execFile);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const extGroups = {
  模型: ['.blend','.glb','.gltf','.fbx','.obj','.stl','.usd','.usdz'],
  图片: ['.png','.jpg','.jpeg','.webp','.bmp','.tga','.exr','.hdr','.tif','.tiff'],
  动画: ['.bvh','.anim'], 视频: ['.mp4','.mov','.mkv','.webm','.avi'],
  音频: ['.wav','.mp3','.ogg','.flac'], UE: ['.uproject','.uasset','.umap'],
  脚本: ['.py','.cpp','.h','.cs','.js','.ts'], 文档: ['.md','.txt','.json','.pdf']
};
function category(file) { const ext=path.extname(file).toLowerCase(); return Object.keys(extGroups).find(k=>extGroups[k].includes(ext)) || '其他'; }
function inside(root, target) { const rel=path.relative(path.resolve(root),path.resolve(target)); return rel==='' || (!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)); }
function safeName(name) { const s=String(name||'').trim(); if(!s || s.length>80 || /[<>:"/\\|?*\x00-\x1f]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)||s==='.'||s==='..') throw Error('名称无效：请使用 1–80 个字，不含路径或 Windows 保留名称。'); return s; }
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+id()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(data,null,2),'utf8');
  const fd=fs.openSync(tmp,'r+'); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(fs.existsSync(file)) fs.copyFileSync(file,file+'.bak');
  fs.renameSync(tmp,file);
}
class Store {
  constructor(root) {
    this.file=path.join(root,'workstation.json');
    this.data={schema:1,projects:[],activeProjectId:null,tools:[],tasks:[],calls:[],settings:{model:'deepseek-flash',dailyBudget:0.5,callBudget:0.02},cache:{}};
    if(fs.existsSync(this.file)) {
      try { this.data=this.parse(this.file); }
      catch(e) { if(!fs.existsSync(this.file+'.bak')) throw Error('数据文件损坏，已停止启动以保护记录。'+e.message); this.data=this.parse(this.file+'.bak'); this.data.recoveryNotice='主数据损坏，已从上次备份恢复。请核对最近任务。'; fs.copyFileSync(this.file,this.file+'.corrupt-'+Date.now()); }
    }
    for(const t of this.data.tasks) if(['running','queued','cancelling','pausing','paused'].includes(t.status)) {t.status='interrupted';t.error='上次进程意外退出，执行结果未知；请检查输出后创建新任务。'; t.updatedAt=now();}
    this.save();
  }
  parse(file) {const d=JSON.parse(fs.readFileSync(file,'utf8')); if(d.schema!==1||!['tasks','projects','tools','calls'].every(k=>Array.isArray(d[k])&&d[k].every(x=>x&&typeof x==='object'))||!d.settings||typeof d.settings!=='object'||Array.isArray(d.settings)||!d.cache||typeof d.cache!=='object'||Array.isArray(d.cache)) throw Error('不支持的数据结构'); return d;}
  save(){atomicWrite(this.file,this.data);}
  project(){const p=this.data.projects.find(p=>p.id===this.data.activeProjectId);if(!p)throw Error('请先创建或打开一个工作站项目。');if(!fs.existsSync(p.root))throw Error('项目目录不存在，请重新打开项目。');return p;}
  switchProject(id){const p=this.data.projects.find(p=>p.id===id);if(!p)throw Error('项目不存在');if(!fs.existsSync(p.root)||!fs.statSync(p.root).isDirectory())throw Error('项目目录不存在，请重新打开项目。');this.data.activeProjectId=id;p.lastOpenedAt=now();this.save();return p;}
  createProject(parent,name){
    name=safeName(name);parent=fs.realpathSync(parent); const root=path.join(parent,name);
    if(fs.existsSync(root)) throw Error('同名目录已存在，请使用其他项目名称。');
    fs.mkdirSync(root);fs.mkdirSync(path.join(root,'Assets'));fs.mkdirSync(path.join(root,'Generated'));
    const p={id:id(),name,root,createdAt:now(),lastOpenedAt:now()};
    atomicWrite(path.join(root,'.aigw-project.json'),{schema:1,...p});
    this.data.projects.unshift(p);this.data.activeProjectId=p.id;this.save();return p;
  }
  openProject(root){root=fs.realpathSync(root);const f=path.join(root,'.aigw-project.json');if(!fs.existsSync(f))throw Error('该目录不是本版工作站项目。可先新建项目，再导入素材。');const m=JSON.parse(fs.readFileSync(f,'utf8'));if(m.schema!==1||typeof m.id!=='string'||typeof m.name!=='string')throw Error('项目标识无效。');const p={id:m.id,name:m.name,createdAt:m.createdAt,root,lastOpenedAt:now()};this.data.projects=this.data.projects.filter(x=>x.id!==p.id);this.data.projects.unshift(p);this.data.activeProjectId=p.id;this.save();return p;}
}
function scanAssets(root,limit=4000) {
  const out=[],folders=[],errors=[];let truncated=false;const realRoot=fs.realpathSync(root);
  const imageMime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.bmp':'image/bmp'};
  function walk(dir,depth){if(depth>10){truncated=true;return;}let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){errors.push({path:dir,code:e.code||'SCAN_ERROR'});return;}for(const ent of entries){
    if(out.length>=limit){truncated=true;return;}
    if(ent.name.startsWith('.')||['node_modules','Intermediate','Saved','DerivedDataCache','Binaries'].includes(ent.name)||ent.isSymbolicLink())continue;
    const file=path.join(dir,ent.name);
    if(ent.isDirectory()){try{const s=fs.statSync(file);folders.push({id:'folder-'+crypto.createHash('sha1').update(file).digest('hex').slice(0,16),name:ent.name,path:file,relative:path.relative(realRoot,file),category:'文件夹',ext:'',bytes:0,modified:s.mtime.toISOString(),kind:'folder'});}catch(e){errors.push({path:file,code:e.code||'SCAN_ERROR'});}walk(file,depth+1);continue;}
    if(!ent.isFile())continue;
    try{const s=fs.statSync(file),ext=path.extname(file).toLowerCase(),item={id:crypto.createHash('sha1').update(file).digest('hex').slice(0,16),name:ent.name,path:file,relative:path.relative(realRoot,file),category:category(file),ext,bytes:s.size,modified:s.mtime.toISOString(),kind:'file'};if(imageMime[ext]&&s.size<=4*1024*1024)item.thumbnail=`data:${imageMime[ext]};base64,${fs.readFileSync(file).toString('base64')}`;out.push(item);}catch(e){errors.push({path:file,code:e.code||'SCAN_ERROR'});}
  }}walk(realRoot,0);return {assets:out,folders,truncated,errors,scannedAt:now()};
}
function validateExecutable(file,kind){
  const expected=kind==='blender'?'blender.exe':'unrealeditor.exe';
  if(!path.isAbsolute(file)||path.basename(file).toLowerCase()!==expected)throw Error('请选择实际的 '+expected+' 可执行文件。');
  const real=fs.realpathSync(file);const fd=fs.openSync(real,'r');const magic=Buffer.alloc(2);fs.readSync(fd,magic,0,2,0);fs.closeSync(fd);if(magic.toString()!=='MZ')throw Error('文件不是有效的 Windows 可执行文件。');return real;
}
async function toolFromFile(file,kind,source='自动发现'){
  file=validateExecutable(file,kind);let version='已校验文件';
  if(kind==='blender'){try{const r=await runFile(file,['--version'],{windowsHide:true,timeout:12000,maxBuffer:16384});version=r.stdout.split(/\r?\n/).find(l=>/^Blender /.test(l))||version;}catch(e){throw Error('Blender 版本验证失败：'+e.message);}}
  else {const build=path.resolve(file,'../../../Build/Build.version');try{const b=JSON.parse(fs.readFileSync(build,'utf8'));version=`${b.MajorVersion}.${b.MinorVersion}.${b.PatchVersion}`;}catch{version='UE · 文件已验证，版本未知';}}
  return {id:crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0,12),kind,path:file,version,source,validatedAt:now(),status:'verified',connected:false};
}
async function discoverTools(previous=[]){
  const candidates=new Map();const add=(f,k,s)=>{if(fs.existsSync(f))candidates.set(f.toLowerCase(),{file:f,kind:k,source:s});};
  for(const t of previous)add(t.path,t.kind,'已绑定');
  const roots=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],path.join(process.env.LOCALAPPDATA||'','Programs')].filter(Boolean);
  for(const d of ['C:\\','D:\\','E:\\','F:\\'])if(fs.existsSync(d)){add(path.join(d,'blender.exe'),'blender','磁盘根目录便携版');try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.isDirectory()&&!e.isSymbolicLink()&&/blender|^UE[_ -]|^Epic Games$|^Program Files$/i.test(e.name))roots.push(path.join(d,e.name));}}catch{}}
  function search(dir,depth){if(depth>3)return;try{add(path.join(dir,'blender.exe'),'blender','安装目录');add(path.join(dir,'Engine','Binaries','Win64','UnrealEditor.exe'),'ue','安装目录');for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isDirectory()&&!e.isSymbolicLink()&&/blender|^\d\.\d|^UE[_ -]|^Epic Games$|^Blender Foundation$/i.test(e.name))search(path.join(dir,e.name),depth+1);}}catch{}}
  for(const root of roots)search(root,0);
  try{const epic=JSON.parse(fs.readFileSync(path.join(process.env.ProgramData||'C:\\ProgramData','Epic','UnrealEngineLauncher','LauncherInstalled.dat'),'utf8'));for(const t of epic.InstallationList||[])if(t.InstallLocation)add(path.join(t.InstallLocation,'Engine','Binaries','Win64','UnrealEditor.exe'),'ue','Epic 安装清单');}catch{}
  for(const [key,kind] of [['HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds','ue'],['HKLM\\SOFTWARE\\EpicGames\\Unreal Engine','ue'],['HKLM\\SOFTWARE\\BlenderFoundation','blender']]){
    try{const r=await runFile('reg.exe',['query',key,'/s'],{windowsHide:true,timeout:5000,maxBuffer:65536});for(const l of r.stdout.split(/\r?\n/)){const m=l.match(/REG_SZ\s+(.+)$/);if(m){const d=m[1].trim();add(path.join(d,...(kind==='ue'?['Engine','Binaries','Win64','UnrealEditor.exe']:['blender.exe'])),kind,'Windows 注册信息');}}}catch{}
  }
  for(const dir of (process.env.PATH||'').split(path.delimiter))if(dir)add(path.join(dir,'blender.exe'),'blender','PATH');
  const tools=[],errors=[];
  for(const c of candidates.values()){try{tools.push(await toolFromFile(c.file,c.kind,c.source));}catch(e){errors.push({path:c.file,message:e.message});}}
  return {tools,errors,scannedAt:now()};
}
const recipes={crate:{name:'木箱道具',description:'木板、金属包角与 PBR 材质的程序化道具'},pillar:{name:'石柱道具',description:'分段柱身、柱头与石材材质的程序化道具'},blockout:{name:'场景灰盒',description:'地台、立柱与台阶组成的可导入场景'}};
function localPlan(request,recipe){
  request=String(request||'').trim();if(!request)throw Error('请描述要制作的内容。');if(request.length>12000)throw Error('需求过长，请控制在 12000 字以内。');
  const chosen=recipe||(/柱|pillar/i.test(request)?'pillar':/场景|灰盒|blockout|平台/i.test(request)?'blockout':/箱|crate/i.test(request)?'crate':null);
  if(!recipes[chosen])return {request,provider:'local',supported:false,summary:'当前本地工具尚不能执行这个需求。可选木箱、石柱或场景灰盒；角色、动捕和蓝图自动编辑需要后续适配器。',steps:[]};
  return {request,recipe:chosen,provider:'local',supported:true,summary:`制作${recipes[chosen].name}，保存 Blender 工程、GLB 与预览图，并用独立进程重导入检查。`,limitations:'这是确定性的程序化建模。文字影响模板选择；任意形状、参考图重建和自动动画尚未接通。',steps:['检查项目边界与 Blender','在全新任务目录中创建模型、材质和预览','导出 .blend / .glb','用独立 Blender 进程重导入 GLB 并检查网格','扫描并登记输出资产'],cost:0,risk:'仅新建文件，不覆盖已有资产'};
}
const pricing={model:'deepseek-flash',input:0.30,output:1.20,currency:'USD',checkedAt:'2026-11-10',source:'https://api-docs.deepseek.com/quick_start/pricing/'};
function quoteCall(payload,model,budget){
  if(model!==pricing.model)throw Error('此模型未配置已核实价格，已暂停调用。');
  if(Date.now()-Date.parse(pricing.checkedAt)>30*86400000)throw Error('模型价格记录已过有效期，请先更新价格配置。');
  const inputBound=Buffer.byteLength(JSON.stringify(payload),'utf8')+1024;const outputBound=2048;
  const upper=(inputBound*pricing.input+outputBound*pricing.output)/1e6;
  if(!(Number(budget)>=upper))throw Error(`本次费用估算上限 $${upper.toFixed(5)} 超过单次预算。`);
  return {inputBound,outputBound,upper,...pricing,model};
}
function parseGlb(buf){if(buf.length<20||buf.readUInt32LE(0)!==0x46546c67||buf.readUInt32LE(4)!==2||buf.readUInt32LE(8)!==buf.length)throw Error('GLB 文件头或长度无效');const len=buf.readUInt32LE(12);if(buf.readUInt32LE(16)!==0x4e4f534a||20+len>buf.length)throw Error('GLB JSON 块无效');return JSON.parse(buf.subarray(20,20+len).toString('utf8'));}
module.exports={id,now,Store,inside,safeName,atomicWrite,scanAssets,category,validateExecutable,toolFromFile,discoverTools,localPlan,recipes,quoteCall,pricing,parseGlb};
