(function(){
 'use strict';const jobs=new Map(),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function monitor(ctx,job){jobs.set(ctx.projectId,job);ctx.modal('骨架制作与独立验证','<div id="rig-production-result"></div>','',true);const panel=document.querySelector('#rig-production-result');
  while(panel.isConnected){job=await ctx.api('rigBuildPoll',{projectId:ctx.projectId,id:job.id});jobs.set(ctx.projectId,job);panel.innerHTML=`<p>状态：${esc(job.status)} · 阶段：${esc(job.stage)}</p><p>新建目录：${esc(job.output)}</p>${job.status==='running'?'<button id="rig-stop">停止制作</button>':''}${job.result?'<button id="rig-view-result">查看导出模型</button><button id="rig-open-blender">在 Blender 中编辑权重与姿态</button>':''}<p>${esc(job.error||'')}</p>${job.validation?`<pre>${esc(JSON.stringify(job.validation,null,2))}</pre>`:''}<pre class="workbench-build-log">${esc(job.log)}</pre>`;
   const stop=panel.querySelector('#rig-stop');if(stop)stop.onclick=async()=>{stop.disabled=true;await ctx.api('rigBuildCancel',{projectId:ctx.projectId,id:job.id});};
   const view=panel.querySelector('#rig-view-result');if(view)view.onclick=()=>window.Workbench.preview(job.result);
   const blender=panel.querySelector('#rig-open-blender');if(blender)blender.onclick=()=>ctx.api('rigBuildOpen',{projectId:ctx.projectId,id:job.id}).catch(e=>ctx.toast(e.message,true));
   if(!['running','cancelling'].includes(job.status)){await ctx.api('scan');break;}
   await new Promise(resolve=>setTimeout(resolve,700));
  }
 }
 function open(ctx,content){const previous=jobs.get(ctx.projectId);ctx.modal('将人工关节写入真实 Blender 骨架',`<p>来源：${esc(content.asset?.name||'尚未选择模型')} · ${content.joints.length} 个关节</p><p>使用当前关节位置及父级，在项目 Generated 下新建 .blend 和 GLB，并用独立 Blender 进程重导入检查。原模型与骨架草稿保留。</p><label>权重操作<select id="rig-weight-mode"><option value="none">只创建骨架，不蒙皮</option><option value="automatic">创建骨架并执行 Blender 自动权重</option></select></label><p>自动权重需要检查变形效果。权重涂抹与测试姿态可在生成的 Blender 工程中继续编辑。</p><details><summary>查看本次位置与层级</summary><pre class="suggestion-payload">${esc(JSON.stringify(content,null,2))}</pre></details><button id="rig-create-production">确认范围并新建产物</button>${previous?'<button id="rig-last-production">查看上次制作</button>':''}`,'',true);
  document.querySelector('#rig-create-production').onclick=async e=>{e.target.disabled=true;try{const job=await ctx.api('rigBuildStart',{projectId:ctx.projectId,content,weights:document.querySelector('#rig-weight-mode').value});await monitor(ctx,job);}catch(error){ctx.toast(error.message,true);if(e.target.isConnected)e.target.disabled=false;}};
  const last=document.querySelector('#rig-last-production');if(last)last.onclick=()=>monitor(ctx,previous).catch(e=>ctx.toast(e.message,true));
 }
 window.RigProduction={open};
})();
