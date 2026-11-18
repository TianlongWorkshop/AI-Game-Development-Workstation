'use strict';
const fs=require('node:fs'),C=require('./core.cjs'),W=require('./workflow.cjs');
function load(p,ref){
 const a=W.resolve(p,ref);if(!['Image','Video'].includes(a.assetType))throw Error('请选择图片或视频');
 const file=W.file(p,'selections',a.assetId+'-v'+a.version+'.json');
 const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 return {revision:0,metadata:null,recognition:null,annotation:previous?.annotation||{},history:[],...previous,schemaVersion:2,source:{assetId:a.assetId,version:a.version,sha256:a.sha256,name:a.name,assetType:a.assetType}};
}
function validateAnnotation(a,source,metadata){
 if(!a||typeof a.notes!=='string'||a.notes.length>6000)throw Error('媒体说明限 6000 字');
 for(const key of ['subject','action','material'])if(a[key]!==undefined&&(typeof a[key]!=='string'||a[key].length>1000))throw Error('标注字段过长');
 if(source.assetType==='Video'&&(!Number.isFinite(a.start)||!Number.isFinite(a.end)||a.start<0||a.end<=a.start||(Number.isFinite(metadata?.duration)&&a.end>metadata.duration+.01)))throw Error('片段时间必须满足 0 ≤ 起点 < 终点 ≤ 视频时长');
 if(a.points!==undefined&&(!Array.isArray(a.points)||a.points.length>200))throw Error('标注点最多 200 个');
 for(const point of a.points||[]){if(typeof point.label!=='string'||point.label.length>80||![point.x,point.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('标注点须使用 0–1 图像坐标');if(source.assetType==='Video'&&(!Number.isFinite(point.time)||point.time<a.start||point.time>a.end))throw Error('标注点时间必须在所选片段内');}
 return a;
}
function write(p,ref,expectedRevision,kind,value){
 const old=load(p,ref);if(expectedRevision!==undefined&&old.revision!==expectedRevision)throw Error('媒体修订冲突，请重新打开后再修改');
 const next=JSON.parse(JSON.stringify(old));
 if(kind==='metadata'){
  if(!value||!['width','height'].every(k=>Number.isInteger(value[k])&&value[k]>0&&value[k]<=100000))throw Error('媒体尺寸无效');
  if(old.source.assetType==='Video'&&(!Number.isFinite(value.duration)||value.duration<=0))throw Error('视频时长无效');
  next.metadata={...value,status:'decoded',method:'Chromium media decoder',parsedAt:C.now()};
 }else if(kind==='annotation')next.annotation=validateAnnotation(value,old.source,old.metadata);
 else if(kind==='recognition'){
  if(!value||typeof value.provider!=='string'||!value.provider.trim()||typeof value.model!=='string'||!value.model.trim()||!value.source||value.source.sha256!==old.source.sha256||value.source.assetId!==old.source.assetId||value.source.version!==old.source.version)throw Error('识别结果必须包含服务、模型以及匹配的资产 ID、版本、SHA256');
  validateAnnotation(value.result,old.source,old.metadata);
  next.recognition={...value,status:'imported',verification:'external-result-not-executed-by-workstation',importedAt:C.now()};
 }else if(kind==='restore'){
  const entry=old.history.find(h=>h.revision===value);if(!entry)throw Error('历史版本不存在');
  next.annotation=entry.annotation;next.recognition=entry.recognition;
 }else throw Error('未知媒体操作');
 if(Buffer.byteLength(JSON.stringify(next))>1024*1024)throw Error('媒体记录超过 1 MB');
 next.history=[...old.history,{revision:old.revision,annotation:old.annotation,recognition:old.recognition,updatedAt:old.updatedAt||null}].slice(-50);
 next.revision=old.revision+1;next.updatedAt=C.now();next.lastOperation=kind;
 C.atomicWrite(W.file(p,'selections',old.source.assetId+'-v'+old.source.version+'.json'),next);return next;
}
function effective(record){return {...(record.recognition?.result||{}),...record.annotation,source:record.source,manualPriority:true,recognitionStatus:record.recognition?.status||'not-connected'};}
module.exports={load,write,effective,validateAnnotation};
