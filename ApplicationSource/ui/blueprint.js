(function(root,factory){if(typeof module==='object')module.exports=factory();else root.BlueprintText=factory();})(typeof window!=='undefined'?window:this,function(){
 'use strict';
 // 显示名：尽量与 UE 节点标题一致（事件 / 函数 / 变量 / 宏 / 输入动作 / 注释），否则用类名
 function title(block,cls,name){const pick=re=>re.exec(block)?.[1];const short=String(cls).split('.').pop().replace(/^K2Node_/,'');
  const comment=pick(/\bNodeComment="((?:\\.|[^"\\])*)"/);if(/Comment/.test(cls))return comment?comment.replace(/\\n/g,' '):'注释';
  const custom=pick(/\bCustomFunctionName="([^"]+)"/);if(custom)return custom;
  const ev=pick(/\bEventReference=\([^)]*MemberName="([^"]+)"/);if(ev)return 'Event '+ev;
  const fn=pick(/\bFunctionReference=\([^)]*MemberName="([^"]+)"/);if(fn)return fn;
  const v=pick(/\bVariableReference=\([^)]*MemberName="([^"]+)"/);if(v)return (/VariableSet/.test(short)?'Set ':'Get ')+v;
  const macro=pick(/\bMacroGraphReference=\([^)]*MacroGraph="[^"]*:([^".']+)/);if(macro)return macro;
  const ia=pick(/\bInputAction="[^"]*\.([A-Za-z0-9_]+)'?"/)||pick(/\bInputActionName="([^"]+)"/)||pick(/\bInputAxisName="([^"]+)"/);if(ia)return ia;
  const target=pick(/\bTargetType="[^"]*\.([A-Za-z0-9_]+)'?"/);if(target&&/Cast/.test(short))return 'Cast To '+target.replace(/_C$/,'');
  const labels={CallFunction:'调用函数',CallArrayFunction:'调用数组函数',VariableGet:'获取变量',VariableSet:'设置变量',IfThenElse:'分支判断',SwitchInteger:'整数分支',SwitchString:'文本分支',Select:'选择',Event:'事件',CustomEvent:'自定义事件',InputAction:'输入动作',InputAxisEvent:'输入轴事件',DynamicCast:'类型转换',MacroInstance:'宏实例',CreateDelegate:'创建委托',AddDelegate:'添加委托',RemoveDelegate:'移除委托',ComponentBoundEvent:'组件事件',ExecutionSequence:'执行序列',Timeline:'时间轴',Knot:'重定向节点',CommutativeAssociativeBinaryOperator:'数学运算',PureAssignmentStatement:'纯赋值'};
  return labels[short]||short||name;}
 function parse(text){if(typeof text!=='string'||text.length>1500000)throw Error('蓝图文本限 1.5 MB');const nodes=[],issues=[],blocks=text.match(/Begin Object\b[\s\S]*?\r?\nEnd Object/g)||[];for(const block of blocks){const className=/Class=(?:"([^"]+)"|(\S+))/.exec(block),name=/\bName="([^"]+)"/.exec(block)?.[1];if(!name||!className)continue;const pins=[];for(const line of block.split(/\r?\n/).filter(l=>l.includes('CustomProperties Pin ('))){const get=re=>re.exec(line)?.[1]||'';const pin={id:get(/\bPinId=([A-Fa-f0-9]+)/),name:get(/\bPinName="((?:\\.|[^"\\])*)"/),direction:line.includes('Direction="EGPD_Output"')?'output':'input',category:get(/PinType\.PinCategory="([^"]*)"/),subcategory:get(/PinType\.PinSubCategoryObject=([^,)]*)/),links:[]};const linked=/\bLinkedTo=\(([^)]*)\)/.exec(line)?.[1]||'';for(const match of linked.matchAll(/([^\s,]+)\s+([A-Fa-f0-9]{32})/g))pin.links.push({nodeId:match[1],pinId:match[2]});if(pin.id)pins.push(pin);}
   const value=k=>Number(new RegExp('\\b'+k+'=(-?\\d+)').exec(block)?.[1]||0);const cls=className[1]||className[2];nodes.push({id:name,className:cls,title:title(block,cls,name),comment:/EdGraphNode_Comment/.test(cls),size:{w:value('NodeWidth'),h:value('NodeHeight')},guid:/\bNodeGuid=([A-Fa-f0-9]+)/.exec(block)?.[1],position:{x:value('NodePosX'),y:value('NodePosY')},pins});}
  if(!nodes.length)throw Error('没有找到 UE 节点文本。请在 UE 蓝图编辑器选择节点、Ctrl+C，再粘贴到此处。');if(nodes.length>200)throw Error('一次检查最多 200 个节点');const byId=new Map(),edges=[],seen=new Set();const issue=(severity,nodeId,pinId,message)=>issues.push({severity,nodeId,pinId,message});for(const n of nodes){if(byId.has(n.id))issue('error',n.id,null,'重复节点名称');byId.set(n.id,n);const ids=new Set();for(const p of n.pins){if(ids.has(p.id))issue('error',n.id,p.id,'重复引脚 ID');ids.add(p.id);}}
  for(const n of nodes)for(const p of n.pins)for(const link of p.links){const other=byId.get(link.nodeId),q=other?.pins.find(q=>q.id.toLowerCase()===link.pinId.toLowerCase());if(!other){issue('warning',n.id,p.id,'连接到复制范围外的节点：'+link.nodeId);continue;}if(!q){issue('error',n.id,p.id,'目标引脚不存在：'+link.pinId);continue;}if(p.direction===q.direction)issue('error',n.id,p.id,'连接两端方向相同');if(p.category&&q.category&&p.category!==q.category&&p.category!=='wildcard'&&q.category!=='wildcard')issue('review',n.id,p.id,'类型需 UE 验证：'+p.category+' → '+q.category);if(!q.links.some(x=>x.nodeId===n.id&&x.pinId.toLowerCase()===p.id.toLowerCase()))issue('warning',n.id,p.id,'未找到反向链接记录，请在 UE 回读确认');const pair=[n.id+':'+p.id,other.id+':'+q.id].sort().join('|');if(!seen.has(pair)){seen.add(pair);edges.push({from:{nodeId:n.id,pinId:p.id},to:{nodeId:other.id,pinId:q.id}});}}
  return {nodes,edges,issues,scope:'clipboard-subgraph',checkedBy:'local-structural-check',compiled:false};
 }
 return {parse};
});


