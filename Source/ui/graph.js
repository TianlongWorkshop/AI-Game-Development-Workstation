(function(root,factory){if(typeof module==='object')module.exports=factory();else root.WorkGraph=factory();})(typeof window!=='undefined'?window:this,function(){
 'use strict';
 const types={
  'creation.subject':{label:'制作对象',inputs:{models:'Mesh',images:'Image',videos:'Video',notes:'Text'},many:['models','images','videos','notes'],outputs:{mesh:'Mesh'},available:true,manual:true},
  'reference.board':{label:'美术参考板',inputs:{images:'Image',videos:'Video',models:'Mesh',notes:'Text'},many:['images','videos','models','notes'],outputs:{reference:'Image'},available:true,manual:true},
  'animation.context':{label:'动作与角色参考',inputs:{models:'Mesh',images:'Image',videos:'Video',notes:'Text'},many:['models','images','videos','notes'],outputs:{context:'Text'},available:true,manual:true},
  'ue.context':{label:'UE 开发参考',inputs:{images:'Image',videos:'Video',notes:'Text'},many:['images','videos','notes'],outputs:{context:'Text'},available:true,manual:true},
  'note.text':{label:'要求与说明',inputs:{},outputs:{text:'Text'},available:true,manual:true},
  'model.template':{label:'模板建模',inputs:{},outputs:{mesh:'Mesh'},available:true},
  'asset.publish':{label:'保存项目资产',inputs:{mesh:'Mesh'},outputs:{asset:'Mesh'},available:true},
  'asset.reference':{label:'固定版本资产',inputs:{},outputs:{asset:'Mesh'},available:true},
  'mesh.selection':{label:'模型部件选择',inputs:{mesh:'Mesh'},outputs:{selection:'Selection3D'}},
  'spatial.anchor':{label:'安装点选择',inputs:{mesh:'Mesh'},outputs:{anchor:'Anchor3D'}},
  'model.attach':{label:'部件装配',inputs:{source:'Mesh',target:'Anchor3D'},outputs:{mesh:'Mesh'}},
  'rig.fit':{label:'人形骨架拟合',inputs:{mesh:'Mesh'},outputs:{skeleton:'Skeleton'}},
  'rig.skin':{label:'绑定与权重',inputs:{mesh:'Mesh',skeleton:'Skeleton'},outputs:{model:'RiggedModel'}},
  'video.segment':{label:'视频片段',inputs:{video:'Video'},outputs:{segment:'VideoSegment'}},
  'pose.estimate':{label:'视频姿态估计',inputs:{segment:'VideoSegment'},outputs:{pose:'PoseSequence'}},
  'motion.solve':{label:'动作求解',inputs:{pose:'PoseSequence'},outputs:{motion:'MotionClip'}},
  'motion.retarget':{label:'动作骨架映射',inputs:{motion:'MotionClip',skeleton:'Skeleton'},outputs:{motion:'MotionClip'}},
  'motion.edit':{label:'动作编辑',inputs:{motion:'MotionClip',model:'RiggedModel'},outputs:{motion:'MotionClip'}},
  'ue.graph_patch':{label:'UE 图表变更',inputs:{},outputs:{}}
 };
 const clone=x=>JSON.parse(JSON.stringify(x));
 function spec(n){const s=Object.hasOwn(types,n.type)?types[n.type]:null;if(n.type==='asset.reference')return {...s,outputs:{asset:n.parameters?.assetType||'Mesh'}};return s;}
 function validate(g){
  if(!g||g.schemaVersion!==1||!Array.isArray(g.nodes)||!Array.isArray(g.edges)||g.nodes.length>200||g.edges.length>600)throw Error('画布格式错误或超过 200 节点 / 600 连线上限');
  if(g.view&&(![g.view.x,g.view.y,g.view.zoom].every(Number.isFinite)||g.view.zoom<.2||g.view.zoom>2||Math.abs(g.view.x)>1e6||Math.abs(g.view.y)>1e6))throw Error('画布视图参数无效');
  if(typeof g.name!=='string'||g.name.length>80||!Number.isSafeInteger(g.revision)||g.revision<0)throw Error('画布名称或修订无效');
  const nodes=new Map(),edgeIds=new Set(),occupied=new Set(),connections=new Set(),adj=new Map();
  for(const n of g.nodes){if(!n||typeof n.id!=='string'||!n.id||nodes.has(n.id)||typeof n.type!=='string'||!n.position||![n.position.x,n.position.y].every(v=>Number.isFinite(v)&&Math.abs(v)<1e6)||!n.parameters||typeof n.parameters!=='object'||Array.isArray(n.parameters))throw Error('节点标识、参数或位置无效');nodes.set(n.id,n);adj.set(n.id,[]);}
  for(const e of g.edges){const a=nodes.get(e.from?.nodeId),b=nodes.get(e.to?.nodeId);if(!a||!b||typeof e.id!=='string'||edgeIds.has(e.id))throw Error('连线引用不存在或标识重复');edgeIds.add(e.id);const pair=JSON.stringify([e.from,e.to]);if(connections.has(pair))throw Error('同一对端口已连接');connections.add(pair);const key=JSON.stringify([b.id,e.to.portId]);if(occupied.has(key)&&!spec(b)?.many?.includes(e.to.portId))throw Error('输入已连接，请先断开原连线');occupied.add(key);
   const as=spec(a),bs=spec(b);if(as&&bs){const out=as.outputs[e.from.portId],input=bs.inputs[e.to.portId];if(!out||!input||out!==input)throw Error('端口类型不匹配：'+(out||'未知')+' → '+(input||'未知'));}
   if(typeof e.purpose!=='string'||!e.purpose.trim()||e.purpose.length>200)throw Error('连线必须注明用途');adj.get(a.id).push(b.id);
  }
  const active=new Set(),done=new Set();function visit(id){if(active.has(id))throw Error('制作画布不允许循环依赖');if(done.has(id))return;active.add(id);adj.get(id).forEach(visit);active.delete(id);done.add(id);}nodes.forEach((_,id)=>visit(id));return g;
 }
 function dependencies(g,id){const found=new Set();function visit(n){if(found.has(n))return;found.add(n);g.edges.filter(e=>e.to.nodeId===n).forEach(e=>visit(e.from.nodeId));}visit(id);return found;}
 function signature(g,id){const ids=dependencies(g,id);return JSON.stringify({nodes:g.nodes.filter(n=>ids.has(n.id)).map(n=>({id:n.id,type:n.type,typeVersion:n.typeVersion,parameters:n.parameters})).sort((a,b)=>a.id.localeCompare(b.id)),edges:g.edges.filter(e=>ids.has(e.to.nodeId)).map(e=>({from:e.from,to:e.to,purpose:e.purpose,bindingPolicy:e.bindingPolicy})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});}
 function starter(projectId,workflowId='main',recipe='crate'){return {schemaVersion:1,projectId,workflowId,revision:0,name:'游戏资产制作',view:{x:40,y:60,zoom:1},nodes:[{id:'model',type:'model.template',typeVersion:1,position:{x:20,y:40},parameters:{recipe}},{id:'result',type:'asset.publish',typeVersion:1,position:{x:390,y:40},parameters:{name:'制作结果'}}],edges:[{id:'model-result',from:{nodeId:'model',portId:'mesh'},to:{nodeId:'result',portId:'mesh'},purpose:'保存已验证模型',bindingPolicy:'resolvedAtRun'}]};}
 function workspace(projectId,workspaceId,workflowId='workspace-'+workspaceId){const config={create:['3D 制作画布','creation.subject',{category:'prop',name:'物品',instructions:''}],animation:['动画参考画布','animation.context',{name:'角色与动作',instructions:''}],materials:['美术与材质画布','reference.board',{name:'参考板',instructions:''}],ue:['虚幻 5 参考画布','ue.context',{name:'开发参考',instructions:''}]}[workspaceId];if(!config)throw Error('未知工作区');return {schemaVersion:1,projectId,workflowId,workspaceId,revision:0,name:config[0],view:{x:40,y:60,zoom:1},nodes:[{id:'subject',type:config[1],typeVersion:1,position:{x:300,y:70},parameters:config[2]}],edges:[]};}
 return {types,spec,clone,validate,dependencies,signature,starter,workspace};
});
