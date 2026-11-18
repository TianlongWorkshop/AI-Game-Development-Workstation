(function(root,factory){if(typeof module==='object')module.exports=factory(require('./graph.js'));else root.ChangeReview=factory(root.WorkGraph);})(typeof window!=='undefined'?window:this,function(G){
 'use strict';
 const clone=o=>JSON.parse(JSON.stringify(o));
 function prepare(graph,selected,result){
  G.validate(graph);if(!Array.isArray(selected)||!selected.length)throw Error('先选择要修改的节点');
  if(!result||typeof result.summary!=='string'||result.summary.length>6000||!Array.isArray(result.edits)||result.edits.length>100)throw Error('建议格式无效，需要 summary 和 edits');
  const candidate=clone(graph),changes=[],seen=new Set();
  for(const edit of result.edits){
   const node=candidate.nodes.find(n=>n.id===edit.nodeId);
   if(!node||!selected.includes(node.id)||!G.spec(node)?.manual)throw Error('建议越出所选人工节点范围');
   if(!['name','instructions','text','category'].includes(edit.field)||typeof edit.value!=='string'||edit.value.length>(edit.field==='instructions'?6000:200))throw Error('建议包含不支持的修改字段');
   if(edit.field==='category'&&(node.type!=='creation.subject'||!['character','prop','scene'].includes(edit.value)))throw Error('制作类别无效');
   if(edit.field==='text'&&node.type!=='note.text')throw Error('只有说明节点支持内容字段');
   const key=edit.nodeId+':'+edit.field;if(seen.has(key))throw Error('建议重复修改同一字段');seen.add(key);
   const before=node.parameters[edit.field]||'';if(before===edit.value)continue;
   changes.push({nodeId:node.id,field:edit.field,before,after:edit.value});node.parameters[edit.field]=edit.value;
  }
  G.validate(candidate);return {summary:result.summary,changes,base:clone(graph),candidate,selected:[...selected]};
 }
 function apply(graph,review){
  // Compare the full definition, not only the touched field: moved nodes and new references invalidate a review too.
  if(JSON.stringify(graph)!==JSON.stringify(review.base))throw Error('画布在建议生成后已改变，请重新审阅');
  return clone(review.candidate);
 }
 return {prepare,apply};
});
