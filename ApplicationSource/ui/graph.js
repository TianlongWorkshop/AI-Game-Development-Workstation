(function(root,factory){if(typeof module==='object')module.exports=factory();else root.WorkGraph=factory();})(typeof window!=='undefined'?window:this,function(){
 'use strict';
 const types={
  'creation.subject':{label:'制作对象',inputs:{models:'Mesh',images:'Image',videos:'Video',notes:'Text'},many:['models','images','videos','notes'],outputs:{mesh:'Mesh'},available:true,manual:true},
  'reference.board':{label:'参考板',inputs:{images:'Image',videos:'Video',models:'Mesh',notes:'Text'},many:['images','videos','models','notes'],outputs:{reference:'Image'},available:true,manual:true},
  'animation.context':{label:'动作与角色参考',inputs:{models:'Mesh',images:'Image',videos:'Video',notes:'Text'},many:['models','images','videos','notes'],outputs:{context:'Text'},available:true,manual:true},
  'ue.context':{label:'UE 开发参考',inputs:{images:'Image',videos:'Video',notes:'Text'},many:['images','videos','notes'],outputs:{context:'Text'},available:true,manual:true},
  'scene.layout':{label:'场景 CAD 空间图',inputs:{images:'Image',notes:'Text'},many:['images','notes'],outputs:{layout:'SpatialLayout'},available:true,manual:true},
  'scene.blockout':{label:'空间灰盒',inputs:{layout:'SpatialLayout'},outputs:{mesh:'Mesh'},available:true,manual:true},
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
  'ue.graph_patch':{label:'UE 图表变更',inputs:{},outputs:{}},
  // 这些节点只属于“美术与材质”工作区，其他画布不会列出。
  'material.texture.color':{label:'颜色纹理',workspace:'materials',inputs:{uv:'UV'},outputs:{color:'Color'},available:true,manual:true},
  'material.texture.data':{label:'数据纹理',workspace:'materials',inputs:{uv:'UV'},outputs:{data:'Data'},available:true,manual:true},
  'material.texture.coordinate':{label:'空间坐标',workspace:'materials',inputs:{},outputs:{uv:'UV'},available:true,manual:true},
  'material.texture.mapping':{label:'纹理映射',workspace:'materials',inputs:{uv:'UV'},outputs:{uv:'UV'},available:true,manual:true},
  'material.texture.dimension':{label:'空间维度',workspace:'materials',inputs:{uv:'UV'},outputs:{uv:'UV'},available:true,manual:true},
  'material.rgb.split':{label:'RGB 通道拆分',workspace:'materials',inputs:{color:'Color'},outputs:{r:'Scalar',g:'Scalar',b:'Scalar'},available:true,manual:true},
  'material.rgb.combine':{label:'RGB 通道合成',workspace:'materials',inputs:{r:'Scalar',g:'Scalar',b:'Scalar'},outputs:{color:'Color'},available:true,manual:true},
  'material.channel.baseColor':{label:'基础色',workspace:'materials',inputs:{color:'Color'},outputs:{value:'Color'},available:true,manual:true},
  'material.channel.normal':{label:'法线贴图',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Normal'},available:true,manual:true},
  'material.channel.roughness':{label:'粗糙度',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Scalar'},available:true,manual:true},
  'material.channel.metallic':{label:'金属度',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Scalar'},available:true,manual:true},
  'material.channel.ao':{label:'环境遮光',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Scalar'},available:true,manual:true},
  'material.channel.height':{label:'高度 / 位移',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Height'},available:true,manual:true},
  'material.channel.specular':{label:'镜面反射',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Scalar'},available:true,manual:true},
  'material.channel.emission':{label:'发光',workspace:'materials',inputs:{color:'Color'},outputs:{value:'Color'},available:true,manual:true},
  'material.channel.mask':{label:'遮罩 / 不透明度',workspace:'materials',inputs:{data:'Data'},outputs:{value:'Scalar'},available:true,manual:true},
  'material.channel.subsurface':{label:'次表面散射',workspace:'materials',inputs:{color:'Color'},outputs:{value:'Color'},available:true,manual:true},
  'material.shader.principled':{label:'PBR 主材质',workspace:'materials',inputs:{baseColor:'Color',normal:'Normal',roughness:'Scalar',metallic:'Scalar',ao:'Scalar',height:'Height',specular:'Scalar',emission:'Color',mask:'Scalar',subsurface:'Color'},outputs:{shader:'Shader'},available:true,manual:true},
  'material.output':{label:'材质输出',workspace:'materials',inputs:{surface:'Shader'},outputs:{},available:true,manual:true}
 };
 const portLabels={images:'图片',videos:'视频',models:'模型',notes:'说明',image:'图片',video:'视频',model:'模型',mesh:'模型',text:'文字',reference:'参考图',asset:'资产',context:'上下文',selection:'部件选择',anchor:'安装点',skeleton:'骨架',segment:'视频片段',pose:'姿态序列',motion:'动作片段',source:'源模型',target:'目标模型',layout:'空间布局',uv:'空间坐标',color:'颜色',data:'数据',r:'红色通道',g:'绿色通道',b:'蓝色通道',value:'数值',baseColor:'基础色',normal:'法线',roughness:'粗糙度',metallic:'金属度',ao:'环境遮光',height:'高度 / 位移',specular:'镜面反射',emission:'发光',mask:'遮罩',subsurface:'次表面散射',surface:'表面材质',shader:'着色器'};
 const typeLabels={Mesh:'模型',Image:'图片',Video:'视频',Text:'文字',SpatialLayout:'空间布局',Skeleton:'骨架',RiggedModel:'已绑定模型',VideoSegment:'视频片段',PoseSequence:'姿态序列',MotionClip:'动作片段',Selection3D:'三维部件选择',Anchor3D:'三维安装点',UV:'空间坐标',Color:'颜色',Data:'数据纹理',Normal:'法线',Scalar:'数值',Height:'高度 / 位移',Shader:'着色器'};
 const portLabel=p=>portLabels[p]||p;
 const typeLabel=t=>typeLabels[t]||t;
 const clone=x=>JSON.parse(JSON.stringify(x));
 function spec(n){const s=Object.hasOwn(types,n.type)?types[n.type]:null;if(n.type==='asset.reference')return {...s,outputs:{asset:n.parameters?.assetType||'Mesh'}};return s;}
 function validate(g){
  if(!g||g.schemaVersion!==1||!Array.isArray(g.nodes)||!Array.isArray(g.edges)||g.nodes.length>200||g.edges.length>600)throw Error('画布格式错误或超过 200 个节点 / 600 条连线限制');
  if(g.view&&(![g.view.x,g.view.y,g.view.zoom].every(Number.isFinite)||g.view.zoom<.2||g.view.zoom>2||Math.abs(g.view.x)>1e6||Math.abs(g.view.y)>1e6))throw Error('画布视图参数无效');
  if(typeof g.name!=='string'||g.name.length>80||!Number.isSafeInteger(g.revision)||g.revision<0)throw Error('画布名称或修订无效');
  const nodes=new Map(),edgeIds=new Set(),occupied=new Set(),connections=new Set(),adj=new Map();
  for(const n of g.nodes){if(!n||typeof n.id!=='string'||!n.id||nodes.has(n.id)||typeof n.type!=='string'||!n.position||![n.position.x,n.position.y].every(v=>Number.isFinite(v)&&Math.abs(v)<1e6)||!n.parameters||typeof n.parameters!=='object'||Array.isArray(n.parameters))throw Error('节点标识、参数或位置无效');nodes.set(n.id,n);adj.set(n.id,[]);}
  for(const e of g.edges){const a=nodes.get(e.from?.nodeId),b=nodes.get(e.to?.nodeId);if(!a||!b||typeof e.id!=='string'||edgeIds.has(e.id))throw Error('连线引用不存在或标识重复');edgeIds.add(e.id);const pair=JSON.stringify([e.from,e.to]);if(connections.has(pair))throw Error('同一对端口已经连线');connections.add(pair);const key=JSON.stringify([b.id,e.to.portId]);if(occupied.has(key)&&!spec(b)?.many?.includes(e.to.portId))throw Error('输入已经连接，请先断开原连线');occupied.add(key);
   const as=spec(a),bs=spec(b);if(as&&bs){const out=as.outputs[e.from.portId],input=bs.inputs[e.to.portId];if(!out||!input||out!==input)throw Error('端口类型不匹配：'+(out||'未知')+' → '+(input||'未知'));}
   if(typeof e.purpose!=='string'||!e.purpose.trim()||e.purpose.length>200)throw Error('连线必须注明用途');adj.get(a.id).push(b.id);
  }
  const active=new Set(),done=new Set();function visit(id){if(active.has(id))throw Error('制作画布不允许循环依赖');if(done.has(id))return;active.add(id);adj.get(id).forEach(visit);active.delete(id);done.add(id);}nodes.forEach((_,id)=>visit(id));return g;
 }
 function dependencies(g,id){const found=new Set();function visit(n){if(found.has(n))return;found.add(n);g.edges.filter(e=>e.to.nodeId===n).forEach(e=>visit(e.from.nodeId));}visit(id);return found;}
 function signature(g,id){const ids=dependencies(g,id);return JSON.stringify({nodes:g.nodes.filter(n=>ids.has(n.id)).map(n=>({id:n.id,type:n.type,typeVersion:n.typeVersion,parameters:n.parameters})).sort((a,b)=>a.id.localeCompare(b.id)),edges:g.edges.filter(e=>ids.has(e.to.nodeId)).map(e=>({from:e.from,to:e.to,purpose:e.purpose,bindingPolicy:e.bindingPolicy})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});}
 function starter(projectId,workflowId='main',recipe='crate'){return {schemaVersion:1,projectId,workflowId,revision:0,name:'游戏资产制作',view:{x:40,y:60,zoom:1},nodes:[{id:'model',type:'model.template',typeVersion:1,position:{x:20,y:40},parameters:{recipe}},{id:'result',type:'asset.publish',typeVersion:1,position:{x:390,y:40},parameters:{name:'制作结果'}}],edges:[{id:'model-result',from:{nodeId:'model',portId:'mesh'},to:{nodeId:'result',portId:'mesh'},purpose:'保存已验证模型',bindingPolicy:'resolvedAtRun'}]};}
 function materialWorkspace(projectId,workflowId){return {schemaVersion:1,projectId,workflowId,workspaceId:'materials',revision:0,name:'美术与材质画布',view:{x:40,y:60,zoom:1},nodes:[
   {id:'coordinates',type:'material.texture.coordinate',typeVersion:1,position:{x:20,y:80},parameters:{name:'空间坐标',space:'UV'}},
   {id:'color-texture',type:'material.texture.color',typeVersion:1,position:{x:260,y:40},parameters:{name:'颜色纹理',dimension:'2D'}},
   {id:'base-color',type:'material.channel.baseColor',typeVersion:1,position:{x:520,y:40},parameters:{name:'基础色'}},
   {id:'pbr',type:'material.shader.principled',typeVersion:1,position:{x:780,y:40},parameters:{name:'PBR 主材质'}},
   {id:'output',type:'material.output',typeVersion:1,position:{x:1080,y:40},parameters:{name:'材质输出'}}
 ],edges:[
   {id:'coordinates-color',from:{nodeId:'coordinates',portId:'uv'},to:{nodeId:'color-texture',portId:'uv'},purpose:'提供模型 UV 空间',bindingPolicy:'resolvedAtRun'},
   {id:'color-base',from:{nodeId:'color-texture',portId:'color'},to:{nodeId:'base-color',portId:'color'},purpose:'颜色纹理作为基础色来源',bindingPolicy:'resolvedAtRun'},
   {id:'base-pbr',from:{nodeId:'base-color',portId:'value'},to:{nodeId:'pbr',portId:'baseColor'},purpose:'连接基础色通道',bindingPolicy:'resolvedAtRun'},
   {id:'pbr-output',from:{nodeId:'pbr',portId:'shader'},to:{nodeId:'output',portId:'surface'},purpose:'输出到材质表面',bindingPolicy:'resolvedAtRun'}
 ]};}
 function workspace(projectId,workspaceId,workflowId='workspace-'+workspaceId){
  if(workspaceId==='materials')return materialWorkspace(projectId,workflowId);
  const config={create:['3D 制作画布','creation.subject',{category:'prop',name:'物品',instructions:''}],animation:['动画参考画布','animation.context',{name:'角色与动作',instructions:''}],ue:['虚幻 5 参考画布','ue.context',{name:'开发参考',instructions:''}]}[workspaceId];
  if(!config)throw Error('未知工作区');
  return {schemaVersion:1,projectId,workflowId,workspaceId,revision:0,name:config[0],view:{x:40,y:60,zoom:1},nodes:[{id:'subject',type:config[1],typeVersion:1,position:{x:300,y:70},parameters:config[2]}],edges:[]};
 }
 return {types,spec,clone,validate,dependencies,signature,starter,workspace,portLabel,typeLabel};
});
