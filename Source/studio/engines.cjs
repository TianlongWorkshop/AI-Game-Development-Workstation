'use strict';
// 引擎桥接：Blender（无头执行 / 实时连接）与 Unreal Engine（Python 执行 / 构建 / 测试 / 打包 / 运行）。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const P = require('./procs.cjs');
const SCRIPTS = __dirname;

// ---------------- 通用实时连接（行分隔 JSON over TCP） ----------------
class LiveLink {
  constructor(kind){ this.kind = kind; this.port = 0; this.token = ''; this.job = null; this.ready = false; }
  get state(){ return {kind:this.kind, connected:this.ready, port:this.port, pid:this.job?.job?.pid||null, jobId:this.job?.id||null, info:this.info||null}; }
  async request(payload, timeout=600000){
    if(!this.ready) throw Error((this.kind==='blender'?'Blender':'UE')+' 实时连接未建立');
    return await new Promise((resolve, reject)=>{
      const sock = net.createConnection({host:'127.0.0.1', port:this.port});
      let buf = ''; const timer = setTimeout(()=>{ sock.destroy(); reject(Error('实时请求超时')); }, timeout+5000);
      sock.on('connect', ()=>sock.write(JSON.stringify({id:crypto.randomUUID(), token:this.token, timeout:Math.round(timeout/1000), ...payload})+'\n'));
      sock.on('data', d=>{ buf += d.toString('utf8'); const i = buf.indexOf('\n'); if(i>=0){ clearTimeout(timer); sock.end(); try{ resolve(JSON.parse(buf.slice(0,i))); }catch(e){ reject(Error('实时响应解析失败')); } } });
      sock.on('error', e=>{ clearTimeout(timer); reject(Error('实时连接失败：'+e.message)); });
      sock.on('close', ()=>{ clearTimeout(timer); });
    });
  }
  async waitReady(ms=120000){
    const deadline = Date.now()+ms;
    while(Date.now()<deadline){
      if(this.job?.job?.status && this.job.job.status!=='running') throw Error('引擎进程已退出：'+(this.job.job.log||'').slice(-500));
      try{ const sock = net.createConnection({host:'127.0.0.1', port:this.port}); await new Promise((res,rej)=>{ sock.once('connect',res); sock.once('error',rej); setTimeout(()=>rej(Error('t')),1500); }); sock.destroy();
        this.ready = true; const pong = await this.request({type:'ping'}, 20000); this.info = pong.result||null; return this.state;
      }catch{ await new Promise(r=>setTimeout(r,1200)); }
    }
    this.ready = false; throw Error('等待引擎桥接超时（请确认引擎已启动并加载脚本）');
  }
  disconnect(){ this.ready=false; if(this.job?.job?.status==='running') try{ P.cancel(this.job.id); }catch{} this.job=null; this.info=null; }
}
const links = {blender:new LiveLink('blender'), ue:new LiveLink('ue')};
function freePort(base){ return base + Math.floor(Math.random()*500); }

// ---------------- Blender ----------------
function blenderArgsBase(){ return ['-noaudio', '--factory-startup']; }

/** 无头执行：mode = script | inspect | convert */
async function blenderRun(tool, {mode='script', script='', input=null, output=null, saveBlend=null, outDir, preview=false, timeout=1800000, title='Blender 任务', projectId}){
  fs.mkdirSync(outDir, {recursive:true});
  const cfgPath = path.join(outDir, 'task.json');
  fs.writeFileSync(cfgPath, JSON.stringify({mode, script, input, output, save_blend:saveBlend, out_dir:outDir, preview}, null, 2), 'utf8');
  const r = await P.run({kind:'blender', title, projectId, exe:tool.path, timeout,
    args:[...blenderArgsBase(), '-b', '--python', path.join(SCRIPTS,'blender_runner.py'), '--', cfgPath],
    logFile: path.join(outDir, 'blender.log')}).promise;
  let result = null;
  try{ result = JSON.parse(fs.readFileSync(path.join(outDir,'result.json'),'utf8')); }catch{}
  if(!result) throw Error('Blender 未返回结果（退出码 '+r.code+'）\n'+r.log.slice(-1500));
  if(!result.ok) throw Error('Blender 执行失败：'+(result.error||'未知')+'\n'+(result.traceback||'').slice(-1500));
  return {...result, jobId:r.job.id, exitCode:r.code, outDir};
}

async function blenderConnect(tool, {blendFile=null, projectId}={}){
  if(links.blender.ready) return links.blender.state;
  links.blender.port = freePort(9300); links.blender.token = crypto.randomBytes(12).toString('hex');
  const args = [...(blendFile?[blendFile]:[]), '--python', path.join(SCRIPTS,'blender_live.py'), '--', String(links.blender.port), links.blender.token];
  links.blender.job = P.run({kind:'blender-live', title:'Blender 实时会话', projectId, exe:tool.path, args, detachedGui:true, timeout:0x7fffffff});
  return await links.blender.waitReady();
}

// ---------------- Unreal Engine ----------------
function engineRoot(tool){ return path.resolve(path.dirname(tool.path), '..', '..', '..'); }
function cmdExe(tool){ const c = path.join(path.dirname(tool.path), 'UnrealEditor-Cmd.exe'); return fs.existsSync(c)?c:tool.path; }
function uat(tool){ return path.join(engineRoot(tool), 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat'); }
function dotnetUBT(tool){
  const eng = path.join(engineRoot(tool), 'Engine');
  const ubt = path.join(eng, 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll');
  const base = path.join(eng, 'Binaries', 'ThirdParty', 'DotNet');
  let dotnet = null;
  if(fs.existsSync(base)) for(const v of fs.readdirSync(base).filter(n=>/^\d/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))){
    const c = path.join(base, v, 'win-x64', 'dotnet.exe'); if(fs.existsSync(c)){ dotnet = c; break; } }
  if(!dotnet || !fs.existsSync(ubt)) throw Error('此 UE 安装缺少内置 dotnet 或 UnrealBuildTool');
  return {dotnet, ubt};
}
function uprojectInfo(file){
  const json = JSON.parse(fs.readFileSync(file,'utf8'));
  const srcDir = path.join(path.dirname(file), 'Source'); const targets = [];
  const walk = (d, depth=0)=>{ if(depth>5||!fs.existsSync(d)) return; for(const e of fs.readdirSync(d,{withFileTypes:true})){ const f = path.join(d,e.name); if(e.isDirectory()) walk(f, depth+1); else if(e.name.endsWith('.Target.cs')) targets.push(e.name.slice(0,-10)); } };
  walk(srcDir);
  return {path:file, name:path.basename(file,'.uproject'), engineAssociation:json.EngineAssociation||'', modules:(json.Modules||[]).map(m=>m.Name), plugins:(json.Plugins||[]).filter(p=>p.Enabled!==false).map(p=>p.Name), targets:[...new Set(targets)], isCpp:targets.length>0, raw:json};
}
function ensurePlugins(file, names){
  const json = JSON.parse(fs.readFileSync(file,'utf8')); json.Plugins = json.Plugins||[]; let changed = false;
  for(const n of names){ const e = json.Plugins.find(p=>p.Name===n); if(!e){ json.Plugins.push({Name:n, Enabled:true}); changed = true; } else if(e.Enabled===false){ e.Enabled = true; changed = true; } }
  if(changed){ fs.copyFileSync(file, file+'.bak'); fs.writeFileSync(file, JSON.stringify(json, null, '\t'), 'utf8'); }
  return {changed, plugins:json.Plugins.map(p=>p.Name)};
}

/** 以命令行方式执行一段 UE Python（编辑器 -run=pythonscript，无界面）。 */
async function ueExecPython(tool, {uproject, code, outDir, timeout=1800000, title='UE Python', projectId}){
  fs.mkdirSync(outDir, {recursive:true});
  const resultPath = path.join(outDir, 'ue-result.json').replace(/\\/g,'/');
  const file = path.join(outDir, 'ue_task.py');
  const wrapped = `import unreal, json, traceback\nRESULT={'ok':False}\ntry:\n${code.split('\n').map(l=>'    '+l).join('\n')}\n    RESULT['ok']=True\nexcept Exception as e:\n    RESULT['error']=str(e); RESULT['traceback']=traceback.format_exc()[-6000:]\n    unreal.log_error(RESULT['traceback'])\nwith open(r'${resultPath}','w',encoding='utf-8') as f:\n    json.dump(RESULT,f,ensure_ascii=False,indent=2,default=str)\nunreal.log('AIGW_PY_DONE')\n`;
  fs.writeFileSync(file, wrapped, 'utf8');
  const r = await P.run({kind:'ue-python', title, projectId, exe:cmdExe(tool), timeout,
    args:[uproject, '-run=pythonscript', '-script='+file, '-unattended', '-nopause', '-nosplash', '-NullRHI', '-stdout', '-FullStdOutLogOutput'],
    logFile: path.join(outDir, 'ue-python.log')}).promise;
  let result = null; try{ result = JSON.parse(fs.readFileSync(path.join(outDir,'ue-result.json'),'utf8')); }catch{}
  if(!result) throw Error('UE Python 未返回结果（退出码 '+r.code+'）\n'+r.log.slice(-2000));
  if(!result.ok) throw Error('UE Python 失败：'+(result.error||'未知')+'\n'+(result.traceback||'').slice(-1500));
  return {...result, jobId:r.job.id, exitCode:r.code};
}

async function ueConnect(tool, {uproject, projectId}={}){
  if(links.ue.ready) return links.ue.state;
  const info = uprojectInfo(uproject);
  ensurePlugins(uproject, ['PythonScriptPlugin','EditorScriptingUtilities']);
  links.ue.port = freePort(9500); links.ue.token = crypto.randomBytes(12).toString('hex');
  links.ue.job = P.run({kind:'ue-live', title:'UE 编辑器实时会话 · '+info.name, projectId, exe:tool.path, detachedGui:true, timeout:0x7fffffff,
    env:{AIGW_UE_PORT:String(links.ue.port), AIGW_UE_TOKEN:links.ue.token},
    args:[uproject, '-ExecutePythonScript='+path.join(SCRIPTS,'ue_live.py'), '-stdout', '-FullStdOutLogOutput']});
  return await links.ue.waitReady(600000);
}

/** C++ 编译（UnrealBuildTool）。 */
function ueBuild(tool, {uproject, target, configuration='Development', platform='Win64', outDir, projectId}){
  const info = uprojectInfo(uproject);
  if(!info.targets.length) throw Error('此工程没有 C++ Target（纯蓝图工程无需编译）');
  target = target || info.targets.find(t=>t.endsWith('Editor')) || info.targets[0];
  if(!info.targets.includes(target)) throw Error('目标不存在：'+target);
  const {dotnet, ubt} = dotnetUBT(tool);
  fs.mkdirSync(outDir, {recursive:true});
  return P.run({kind:'ue-build', title:`UE 编译 ${target} ${configuration}`, projectId, exe:dotnet, timeout:5400000,
    args:[ubt, target, platform, configuration, '-Project='+uproject, '-WaitMutex', '-NoHotReloadFromIDE'],
    cwd: path.join(engineRoot(tool),'Engine','Source'), env:{DOTNET_ROOT:path.dirname(dotnet)},
    logFile: path.join(outDir, 'ue-build.log')});
}

/** 打包（RunUAT BuildCookRun）。 */
function uePackage(tool, {uproject, configuration='Development', platform='Win64', archiveDir, outDir, projectId}){
  const script = uat(tool); if(!fs.existsSync(script)) throw Error('找不到 RunUAT.bat');
  fs.mkdirSync(archiveDir, {recursive:true}); fs.mkdirSync(outDir, {recursive:true});
  return P.run({kind:'ue-package', title:'UE 打包 '+configuration, projectId, exe:process.env.ComSpec||'cmd.exe', timeout:10800000,
    args:['/c', script, 'BuildCookRun', '-project='+uproject, '-noP4', '-platform='+platform, '-clientconfig='+configuration,
          '-cook', '-build', '-stage', '-pak', '-archive', '-archivedirectory='+archiveDir, '-utf8output', '-nocompileeditor'],
    logFile: path.join(outDir, 'ue-package.log')});
}

/** 自动化测试（UE Automation）。 */
function ueTest(tool, {uproject, tests='Project.Functional Tests', outDir, projectId}){
  fs.mkdirSync(outDir, {recursive:true});
  const reportDir = path.join(outDir, 'TestReport');
  return {job: P.run({kind:'ue-test', title:'UE 自动化测试', projectId, exe:cmdExe(tool), timeout:3600000,
    args:[uproject, '-ExecCmds=Automation RunTests '+tests+';Quit', '-unattended', '-nopause', '-nosplash', '-NullRHI',
          '-ReportExportPath='+reportDir, '-stdout', '-FullStdOutLogOutput'],
    logFile: path.join(outDir,'ue-test.log')}), reportDir};
}

/** 以独立进程启动游戏并录制日志（冒烟测试 / 试玩）。 */
function ueRunGame(tool, {uproject, map='', seconds=0, outDir, projectId, windowed=true, resolution='1280x720'}){
  fs.mkdirSync(outDir, {recursive:true});
  const [w,h] = resolution.split('x');
  const args = [uproject, ...(map?[map]:[]), '-game', ...(windowed?['-windowed', '-ResX='+w, '-ResY='+h]:[]), '-stdout', '-FullStdOutLogOutput', '-unattended', '-nosplash'];
  const handle = P.run({kind:'ue-run', title:'UE 运行游戏', projectId, exe:cmdExe(tool), args, detachedGui:true, timeout: seconds?seconds*1000+60000:0x7fffffff, logFile: path.join(outDir,'ue-run.log')});
  if(seconds) setTimeout(()=>{ try{ P.cancel(handle.id); }catch{} }, seconds*1000);
  return handle;
}

/** 从引擎模板创建新 UE 工程。 */
function listTemplates(tool){
  const dir = path.join(engineRoot(tool), 'Templates'); if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes:true}).filter(e=>e.isDirectory() && e.name.startsWith('TP_'))
    .map(e=>{ const p = path.join(dir, e.name); const up = fs.readdirSync(p).find(n=>n.endsWith('.uproject')); return up?{id:e.name, name:e.name.replace(/^TP_/,''), path:path.join(p,up), blueprintOnly:e.name.endsWith('BP')}:null; }).filter(Boolean);
}
function createFromTemplate(tool, {templateId, destDir, projectName}){
  const t = listTemplates(tool).find(x=>x.id===templateId); if(!t) throw Error('模板不存在：'+templateId);
  if(!/^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(projectName)) throw Error('UE 工程名必须是字母开头的字母数字下划线组合');
  const dest = path.join(destDir, projectName);
  if(fs.existsSync(dest)) throw Error('目标目录已存在：'+dest);
  const srcRoot = path.dirname(t.path), srcName = path.basename(t.path, '.uproject');
  const skip = new Set(['Intermediate','Saved','Binaries','DerivedDataCache','.git','Media','TemplateResources']);
  const copy = (from, to)=>{ fs.mkdirSync(to, {recursive:true});
    for(const e of fs.readdirSync(from, {withFileTypes:true})){
      if(skip.has(e.name) || e.name.endsWith('.uproject.bak')) continue;
      const f = path.join(from, e.name); const renamed = e.name.replace(new RegExp(srcName,'g'), projectName);
      if(e.isDirectory()) copy(f, path.join(to, renamed));
      else if(e.isFile()){
        const target = path.join(to, renamed);
        if(/\.(cs|cpp|h|uproject|ini|Target\.cs|py|txt|md)$/i.test(e.name)){
          let text = fs.readFileSync(f, 'utf8'); text = text.split(srcName).join(projectName);
          if(e.name.endsWith('.uproject')) text = text.replace(/"EngineAssociation":\s*"[^"]*"/, '"EngineAssociation": "'+(tool.version||'').split('.').slice(0,2).join('.')+'"');
          fs.writeFileSync(target, text, 'utf8');
        } else fs.copyFileSync(f, target);
      }
    }};
  copy(srcRoot, dest);
  const uproject = path.join(dest, projectName+'.uproject');
  if(!fs.existsSync(uproject)) throw Error('模板复制后未找到 .uproject');
  ensurePlugins(uproject, ['PythonScriptPlugin','EditorScriptingUtilities']);
  return {...uprojectInfo(uproject), created:true, root:dest};
}
function findUprojects(root, limit=40){
  const out = []; const skip = new Set(['Intermediate','Saved','Binaries','DerivedDataCache','node_modules','.git']);
  const walk = (d, depth)=>{ if(depth>4||out.length>=limit) return; let es; try{ es = fs.readdirSync(d,{withFileTypes:true}); }catch{ return; }
    for(const e of es){ if(out.length>=limit) return; if(e.isDirectory()){ if(!skip.has(e.name)&&!e.name.startsWith('.')) walk(path.join(d,e.name), depth+1); }
      else if(e.isFile()&&e.name.endsWith('.uproject')) out.push(path.join(d,e.name)); } };
  walk(root, 0); return out;
}
module.exports = {links, blenderRun, blenderConnect, ueExecPython, ueConnect, ueBuild, uePackage, ueTest, ueRunGame,
  uprojectInfo, ensurePlugins, listTemplates, createFromTemplate, findUprojects, engineRoot, cmdExe, uat, dotnetUBT};
