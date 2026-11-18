'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),C=require('./core.cjs'),W=require('./workflow.cjs'),R=require('./ui/rig-data.js');
const jobs=new Map();
function start(p,tool,content,weights,stopChild){
 if(!['none','automatic'].includes(weights))throw Error('请选择骨架导出或自动权重');R.validate(content);if(!content.asset)throw Error('先关联真实 GLB 模型');if(R.problems(content).length)throw Error('先修正零骨长');const asset=W.resolve(p,content.asset);if(path.extname(asset.path).toLowerCase()!=='.glb')throw Error('骨架导出需要 GLB');
 if(active())throw Error('已有骨架任务运行');const id=C.id(),base=path.join(p.root,'Generated');fs.mkdirSync(base,{recursive:true});if(!C.inside(fs.realpathSync(p.root),fs.realpathSync(base)))throw Error('输出目录越界');const output=path.join(base,'Rig-'+id);fs.mkdirSync(output);
 const input={schemaVersion:1,asset,content,weights,coordinateSystem:'GLTF_Y_UP_METERS',output};fs.writeFileSync(path.join(output,'rig-input.json'),JSON.stringify(input,null,2));
 const job={id,projectId:p.id,output,status:'running',stage:'create-armature',weights,source:{assetId:asset.assetId,version:asset.version,sha256:asset.sha256},startedAt:C.now(),log:'',exitCode:null,stopChild,child:null,cancelled:false};jobs.set(id,job);
 const persist=()=>C.atomicWrite(W.file(p,'reports','rig-build-'+id+'.json'),publicRecord(job));persist();
 async function phase(mode){await new Promise((resolve,reject)=>{const args=['--background','--factory-startup','--disable-autoexec','--threads','4','--python-exit-code','1','--python',path.join(__dirname,'rig_export.py'),'--',mode,path.join(output,'rig-input.json')];const child=spawn(tool.path,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});job.child=child;let timedOut=false;const timer=setTimeout(()=>{timedOut=true;stopChild(child);},240000);const append=b=>{const s=b.toString('utf8');job.log=(job.log+s).slice(-60000);fs.appendFileSync(path.join(output,'execution.log'),s);};child.stdout.on('data',append);child.stderr.on('data',append);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);job.exitCode=code;job.child=null;if(job.cancelled)reject(Error('用户停止，已保留部分产物'));else if(timedOut)reject(Error('Blender 骨架任务超时'));else if(code!==0)reject(Error('Blender 退出码 '+code+'，请查看执行日志'));else resolve();});});}
 void(async()=>{try{await phase('create');job.stage='independent-reimport';persist();await phase('verify');const validation=JSON.parse(fs.readFileSync(path.join(output,'rig-validation.json'),'utf8'));if(validation.ok!==true)throw Error('骨架重导入验证失败');job.validation=validation;job.result=W.register(p,path.join(output,'rigged.glb'),{rigSource:job.source,weights});job.status='succeeded';job.stage='finished';}catch(e){job.status=job.cancelled?'cancelled':'failed';job.error=e.message;}finally{job.completedAt=C.now();persist();}})();return publicRecord(job);
}
function publicRecord(job){const {child,stopChild,...result}=job;return result;}
function poll(p,id){const job=jobs.get(id);if(!job||job.projectId!==p.id)throw Error('没有此项目的骨架任务');return publicRecord(job);}
function cancel(p,id){const job=jobs.get(id);poll(p,id);if(job.status!=='running')throw Error('任务已经结束');job.cancelled=true;job.status='cancelling';if(job.child)job.stopChild(job.child);return publicRecord(job);}
function active(){return [...jobs.values()].some(j=>['running','cancelling'].includes(j.status));}
function stopAll(){for(const job of jobs.values())if(job.status==='running')cancel({id:job.projectId},job.id);}
module.exports={start,poll,cancel,active,stopAll};
