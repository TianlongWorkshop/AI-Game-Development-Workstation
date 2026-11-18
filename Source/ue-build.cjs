'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{StringDecoder}=require('node:string_decoder'),C=require('./core.cjs'),W=require('./workflow.cjs');
const selected=new Map(),builds=new Map();
function select(p,file){
 file=fs.realpathSync(file);if(path.extname(file).toLowerCase()!=='.uproject'||fs.statSync(file).size>1024*1024)throw Error('需要有效 .uproject');
 const json=JSON.parse(fs.readFileSync(file,'utf8')),source=path.join(path.dirname(file),'Source'),targets=[];
 function scan(dir,depth=0){if(depth>6)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const f=path.join(dir,entry.name);if(entry.isDirectory())scan(f,depth+1);else if(entry.name.endsWith('.Target.cs'))targets.push(entry.name.slice(0,-10));}}if(fs.existsSync(source))scan(source);
 const item={id:C.id(),workspaceProjectId:p.id,path:file,name:path.basename(file),engineAssociation:json.EngineAssociation||'',modules:(json.Modules||[]).map(m=>m.Name),targets:[...new Set(targets)]};selected.set(item.id,item);return item;
}
function prepare(p,tool,{selectionId,target}){
 const item=selected.get(selectionId);if(!item||item.workspaceProjectId!==p.id)throw Error('请重新选择 UE 工程');
 if(!item.targets.includes(target)||!/^[A-Za-z0-9_]+$/.test(target))throw Error('请选择实际存在的 Target.cs 目标');
 const engine=path.resolve(path.dirname(tool.path),'..','..'),dotnetBase=path.join(engine,'Binaries','ThirdParty','DotNet'),ubt=path.join(engine,'Binaries','DotNET','UnrealBuildTool','UnrealBuildTool.dll');let dotnet;
 if(fs.existsSync(dotnetBase))for(const version of fs.readdirSync(dotnetBase).filter(n=>/^\d/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))){const candidate=path.join(dotnetBase,version,'win-x64','dotnet.exe');if(fs.existsSync(candidate)){dotnet=candidate;break;}}
 if(!dotnet||!fs.existsSync(ubt))throw Error('环境缺失：此 UE 安装没有内置 dotnet 或 UnrealBuildTool');
 return {selectionId,target,project:item.path,engine:tool.version,engineRoot:engine,configuration:'Development',platform:'Win64',modules:item.modules,versionWarning:/^\d+\.\d+$/.test(item.engineAssociation)&&!tool.version.startsWith(item.engineAssociation+'.')?'工程关联版本与当前引擎不同，请核对后编译':null,command:{executable:dotnet,args:[ubt,target,'Win64','Development','-Project='+item.path,'-WaitMutex','-NoHotReloadFromIDE']}};
}
function classify(log){if(/(?:SDK|toolchain|Visual Studio|compiler).*(?:not found|not installed|missing|invalid|not a valid)|(?:unable to find|no valid).*(?:SDK|toolchain|Visual Studio|compiler)/i.test(log))return 'environment-missing';return 'compile-error';}
function stage(log){if(/error [A-Z]+\d+|fatal error|error:/i.test(log))return 'diagnostics';if(/Link \[|Linking/.test(log))return 'link';if(/Compile \[|Compiling|\[\d+\/\d+\]/.test(log))return 'compile';if(/UnrealHeaderTool|Parsing headers/.test(log))return 'headers';return 'prepare';}
function publicRecord(b){const {child,stopChild,...record}=b;return record;}
function start(p,tool,args,stopChild){
 const plan=prepare(p,tool,args);if(active())throw Error('已有 UE 构建运行');
 const id=C.id(),report=W.file(p,'reports','ue-build-'+id+'.json'),logPath=W.file(p,'reports','ue-build-'+id+'.log');fs.mkdirSync(path.dirname(report),{recursive:true});
 const job={id,projectId:p.id,...plan,status:'running',stage:'prepare',startedAt:C.now(),log:'',logPath,exitCode:null,diagnosis:null,stopChild,child:null};builds.set(id,job);
 const persist=()=>C.atomicWrite(report,publicRecord(job));persist();fs.writeFileSync(logPath,'');
 const child=spawn(plan.command.executable,plan.command.args,{cwd:path.join(plan.engineRoot,'Source'),env:{...process.env,DOTNET_ROOT:path.dirname(plan.command.executable)},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});job.child=child;
 const append=s=>{job.log=(job.log+s).slice(-150000);fs.appendFileSync(logPath,s);job.stage=stage(job.log);};
 for(const stream of [child.stdout,child.stderr]){const decoder=new StringDecoder('utf8');stream.on('data',b=>append(decoder.write(b)));stream.on('end',()=>append(decoder.end()));}
 child.on('error',e=>{job.status='failed';job.diagnosis='environment-missing';append('\n'+e.message);persist();});
 child.on('close',code=>{job.exitCode=code;job.status=job.status==='cancelling'?'cancelled':code===0?'succeeded':'failed';job.diagnosis=job.status==='failed'?classify(job.log):null;job.stage='finished';job.completedAt=C.now();persist();});return publicRecord(job);
}
function history(p){const dir=W.file(p,'reports');if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>/^ue-build-[\w-]+\.json$/.test(n)).map(n=>{const b=JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));if(!builds.has(b.id)&&['running','cancelling'].includes(b.status))return {...b,status:'interrupted',stage:'unknown',diagnosis:'上次进程中断，未收到退出回执'};return b;}).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,20);}
function poll(p,id){const b=builds.get(id)||history(p).find(b=>b.id===id);if(!b||b.projectId!==p.id)throw Error('没有此项目的构建');return publicRecord(b);}
function cancel(p,id){const b=builds.get(id);poll(p,id);if(!b||b.status!=='running')throw Error('构建已经结束');b.status='cancelling';b.stopChild(b.child);return publicRecord(b);}
function active(){return [...builds.values()].filter(b=>['running','cancelling'].includes(b.status)).length;}
function stopAll(){for(const b of builds.values())if(b.status==='running'){b.status='cancelling';b.stopChild(b.child);}}
module.exports={select,prepare,start,poll,cancel,active,stopAll,history,classify,stage};
