(function(){
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const drafts=new Map();
 async function open(context,reference,result){
  const key=context.projectId+':'+reference.assetId+':'+reference.version;
  let record=await context.api('mediaLoad',{projectId:context.projectId,reference});
  const draft=drafts.get(key)||{annotation:structuredClone(record.annotation),dirty:false,context,reference,revision:record.revision};drafts.set(key,draft);
  context.modal(reference.name||'媒体查看','<div id="workbench-preview" class="workbench-preview media-editor"></div>','',true);
  const panel=document.querySelector('#workbench-preview'),isVideo=result.kind==='video';
  const visual=document.createElement('div');visual.className='media-visual';
  const media=document.createElement(isVideo?'video':'img');media.src=result.data;if(isVideo){media.controls=true;media.preload='auto';}visual.append(media);panel.append(visual);
  const info=document.createElement('p');info.textContent='正在解析媒体信息…';panel.append(info);
  let capture;
  if(isVideo){capture=document.createElement('button');capture.textContent='保存当前参考帧';capture.disabled=true;panel.append(capture);capture.onclick=async()=>{try{const c=document.createElement('canvas'),s=Math.min(1,1920/media.videoWidth);c.width=Math.round(media.videoWidth*s);c.height=Math.round(media.videoHeight*s);c.getContext('2d').drawImage(media,0,0,c.width,c.height);await context.api('mediaCapture',{projectId:context.projectId,reference,time:media.currentTime,data:c.toDataURL('image/png')});context.toast('已保存参考帧及来源时间点。');}catch(e){context.toast(e.message,true);}};}
  const form=document.createElement('div');form.className='media-annotation';panel.append(form);
  let points=structuredClone(draft.annotation.points||[]),loop=false;
  function collect(){const a={notes:form.querySelector('#media-notes').value,subject:form.querySelector('#media-subject').value,action:form.querySelector('#media-action').value,material:form.querySelector('#media-material').value,points:structuredClone(points)};if(isVideo){a.start=Number(form.querySelector('#media-start').value);a.end=Number(form.querySelector('#media-end').value);}return a;}
  function remember(){draft.annotation=collect();draft.dirty=true;form.querySelector('#media-dirty').textContent='有未保存修正';}
  function drawForm(){const a=draft.annotation;form.innerHTML=`<p class="tiny">来源：${esc(record.source.name)} · v${record.source.version}<br>SHA256 ${esc(record.source.sha256)}</p><p>媒体解析：${record.metadata?.status==='decoded'?'已解析真实媒体':'等待解码'} · 语义 / 姿态：${record.recognition?'已导入外部结果（本机未执行识别）':'未连接识别服务'}</p>${isVideo?`<div class="media-time-tools"><label>定位（秒）<input id="media-seek" type="number" min="0" step="0.01" value="0"></label><button type="button" data-media="seek">跳转</button><label>片段起点（秒）<input id="media-start" type="number" min="0" step="0.01" value="${a.start??0}"></label><button data-media="start">用当前帧作起点</button><label>片段终点（秒）<input id="media-end" type="number" min="0" step="0.01" value="${a.end??''}"></label><button data-media="end">用当前帧作终点</button><button data-media="loop">${loop?'停止片段循环':'循环播放片段'}</button></div>`:''}<h4>人工修正（优先于识别结果） <small id="media-dirty">${draft.dirty?'有未保存修正':'已保存'}</small></h4><label>人物 / 对象<input id="media-subject" maxlength="1000" value="${esc(a.subject||'')}"></label><label>动作<input id="media-action" maxlength="1000" value="${esc(a.action||'')}"></label><label>材质 / 颜色<input id="media-material" maxlength="1000" value="${esc(a.material||'')}"></label><textarea id="media-notes" maxlength="6000" placeholder="参考用途、必须保留的范围及禁止项">${esc(a.notes||'')}</textarea><div class="canvas-tools"><label><input type="checkbox" id="media-point-mode">在媒体上标注位置</label><input id="media-point-label" maxlength="80" placeholder="关节 / 部件名称"><button data-media="pop-point">撤销最后标注点</button></div><pre class="media-points">${esc(JSON.stringify(points,null,2))}</pre><button id="media-save-annotation">保存参考标注</button><select id="media-history"><option value="">选择历史版本</option>${record.history.slice().reverse().map(h=>`<option value="${h.revision}">r${h.revision} · ${esc(h.updatedAt||'初始状态')}</option>`).join('')}</select><button data-media="restore">恢复历史（保留当前记录）</button><details><summary>导入外部识别结果 / 查看来源</summary><p>粘贴实际识别服务导出的 JSON。需包含 provider、model、source 和 result；来源必须匹配当前资产。导入不会覆盖人工修正。</p><textarea id="media-recognition" style="height:170px">${esc(JSON.stringify(record.recognition||{provider:'',model:'',source:record.source,result:{notes:'',...(isVideo?{start:0,end:0}:{})}},null,2))}</textarea><button data-media="import-recognition">校验并导入识别结果</button></details>`;
   form.oninput=e=>{if(!['media-recognition','media-seek','media-point-label','media-point-mode'].includes(e.target.id))remember();};
   form.querySelector('#media-save-annotation').onclick=async()=>{try{remember();const value=structuredClone(draft.annotation);record=await context.api('mediaWrite',{projectId:context.projectId,reference,expectedRevision:draft.revision,kind:'annotation',value});draft.revision=record.revision;draft.dirty=JSON.stringify(value)!==JSON.stringify(draft.annotation);drawForm();context.toast('人工修正及来源已保存。');}catch(e){context.toast(e.message,true);}};
   form.onclick=async e=>{const cmd=e.target.closest('[data-media]')?.dataset.media;if(!cmd)return;try{
    if(cmd==='seek'){const time=Number(form.querySelector('#media-seek').value);if(!Number.isFinite(time)||time<0||(Number.isFinite(media.duration)&&time>media.duration))throw Error('定位时间超出视频范围');media.currentTime=time;}
    if(cmd==='start'||cmd==='end'){form.querySelector('#media-'+cmd).value=media.currentTime.toFixed(3);remember();}
    if(cmd==='loop'){const a=collect();if(a.end<=a.start||a.start<0||(Number.isFinite(media.duration)&&a.end>media.duration))throw Error('先填写有效片段起止时间');loop=!loop;if(loop){media.currentTime=a.start;await media.play();}else media.pause();e.target.textContent=loop?'停止片段循环':'循环播放片段';}
    if(cmd==='pop-point'){points.pop();remember();drawForm();}
    if(cmd==='restore'||cmd==='import-recognition'){
     const value=cmd==='restore'?Number(form.querySelector('#media-history').value):JSON.parse(form.querySelector('#media-recognition').value);if(cmd==='restore'&&form.querySelector('#media-history').value==='')throw Error('请选择历史版本');
     if(draft.dirty&&!confirm('先保存当前未保存修正，或继续放弃这些未保存内容？'))return;
     record=await context.api('mediaWrite',{projectId:context.projectId,reference,expectedRevision:draft.revision,kind:cmd==='restore'?'restore':'recognition',value});draft.revision=record.revision;draft.annotation=structuredClone(record.annotation);draft.dirty=false;points=structuredClone(draft.annotation.points||[]);drawForm();
    }
   }catch(error){context.toast(error.message,true);}};
  }
  drawForm();
  visual.onclick=e=>{if(!form.querySelector('#media-point-mode').checked)return;const label=form.querySelector('#media-point-label').value.trim();if(!label){context.toast('先填写关节或部件名称',true);return;}const r=media.getBoundingClientRect(),a=collect(),time=isVideo?media.currentTime:undefined;if(isVideo&&(time<a.start||time>a.end)){context.toast('标注点必须在所选片段内',true);return;}points.push({label,x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)),...(isVideo?{time}:{})});remember();form.querySelector('.media-points').textContent=JSON.stringify(points,null,2);};
  async function metadata(){const width=isVideo?media.videoWidth:media.naturalWidth,height=isVideo?media.videoHeight:media.naturalHeight;if(!width)return;info.textContent=`真实媒体 ${width} × ${height}${isVideo?' · 时长 '+(Number.isFinite(media.duration)?media.duration.toFixed(3)+' 秒':'流媒体时长待确定'):''}；位置标注以左上角为原点。`;if(capture)capture.disabled=false;
   if(record.metadata||(isVideo&&!Number.isFinite(media.duration)))return;
   try{const value={width,height,...(isVideo?{duration:media.duration}:{})};record=await context.api('mediaWrite',{projectId:context.projectId,reference,expectedRevision:draft.revision,kind:'metadata',value});draft.revision=record.revision;}catch(error){context.toast(error.message,true);}
  }
  if(isVideo){media.onloadeddata=metadata;media.ondurationchange=metadata;media.ontimeupdate=()=>{const a=collect();if(loop&&media.currentTime>=a.end){media.currentTime=a.start;void media.play().catch(()=>{});}};}else media.onload=metadata;
  media.onerror=()=>info.textContent='解码失败：请转换为支持的图片或视频格式。语义识别没有执行。';
  const observer=new MutationObserver(()=>{if(!panel.isConnected){if(isVideo){media.pause();media.removeAttribute('src');media.load();}observer.disconnect();}});observer.observe(document.querySelector('#dialog-root'),{childList:true,subtree:true});
 }
 window.MediaEditor={open,dirty:()=>[...drafts.values()].filter(d=>d.dirty).map(d=>d.reference.name||'媒体修正'),async saveAll(){for(const d of drafts.values())if(d.dirty){const value=structuredClone(d.annotation),r=await d.context.api('mediaWrite',{projectId:d.context.projectId,reference:d.reference,expectedRevision:d.revision,kind:'annotation',value});d.revision=r.revision;d.dirty=JSON.stringify(value)!==JSON.stringify(d.annotation);}},discard(){drafts.clear();}};
})();
