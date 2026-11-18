'use strict';
const C=require('./core.cjs');
const models=[
 {id:'local-orchestrator',name:'本地主脑 · 规则路由',provider:'local',kind:'orchestrator',inputs:['text','graph','metadata'],outputs:['json','plan'],workspaces:['create','animation','materials','ue'],available:true,price:'$0',description:'根据真实选择拆分任务并选择本地执行器，不发送文件。'},
 {id:'local-media-parser',name:'本地媒体解析',provider:'local',kind:'vision',inputs:['image','video','file'],outputs:['metadata'],workspaces:['create','animation','materials','ue'],available:true,price:'$0',description:'读取尺寸、时长、编码和参考帧；不冒充语义识别。'},
 {id:'local-blender',name:'Blender 本地执行器',provider:'local',kind:'3d',inputs:['graph','glb','image','video','json'],outputs:['blend','glb','png','report'],workspaces:['create','animation','materials'],available:true,price:'$0',description:'调用本机 Blender 生成、导出和独立重导入验证。'},
 {id:'local-ue-checker',name:'UE 蓝图本地检查器',provider:'local',kind:'blueprint',inputs:['ue-clipboard','uproject'],outputs:['json','html','log'],workspaces:['ue'],available:true,price:'$0',description:'检查真实复制文本、定位节点和保存原文；编译由 UBT 执行。'},
 {id:'local-material-planner',name:'本地材质方案助手',provider:'local',kind:'materials',inputs:['image','video','text'],outputs:['json'],workspaces:['materials'],available:true,price:'$0',description:'根据人工填写的颜色、纹理和禁止项整理材质参数。'},
 {id:'deepseek-flash',name:'DeepSeek Flash（可选云端）',provider:'deepseek',kind:'general',inputs:['text','image'],outputs:['text','json'],workspaces:['create','animation','materials','ue'],available:false,price:'按账户计费',description:'需要用户单独配置 DeepSeek 密钥；本地模式不会自动调用。'}
];
function list(){return models.map(m=>({...m,capabilities:[...m.inputs,'→',...m.outputs]}));}
function get(id){const m=models.find(m=>m.id===id);if(!m)throw Error('模型不存在：'+id);return m;}
function check(id,workspace,inputKinds=[]){const m=get(id);const missing=inputKinds.filter(k=>!m.inputs.includes(k));return {id,workspace,available:m.available&&m.workspaces.includes(workspace)&&!missing.length,missing,reason:!m.available?'此模型未启用':!m.workspaces.includes(workspace)?'不支持当前工作区':missing.length?'缺少输入能力':'本地能力可用',checkedAt:C.now()};}
function route(workspace,task,overrides={}){const main=overrides.main||'local-orchestrator';const specialist=overrides.specialist||({create:'local-blender',animation:'local-blender',materials:'local-material-planner',ue:'local-ue-checker'}[workspace]||'local-orchestrator');return {workspace,task,main, specialist, chain:[main,specialist],localOnly:true,reason:'本地模式：主脑只整理结构化上下文，专用执行器负责实际产物'};}
module.exports={list,get,check,route};
