'use strict';
// 多供应商模型层：主大脑（对话+工具调用）与专项小模型（生图、视觉、语音）统一接口。
// 所有网络请求只在主进程发起；密钥由 vault 提供，从不进入渲染进程或日志。
const fs = require('node:fs');

const PROVIDERS = {
  deepseek:   {name:'DeepSeek', api:'openai', baseUrl:'https://api.deepseek.com', key:true, roles:['brain','coder'], models:['deepseek-chat','deepseek-reasoner','deepseek-flash']},
  openai:     {name:'OpenAI', api:'openai', baseUrl:'https://api.openai.com/v1', key:true, roles:['brain','coder','vision','image','tts'], models:['gpt-5','gpt-5-mini','gpt-4.1','gpt-4o','gpt-image-1','dall-e-3','gpt-4o-mini-tts']},
  anthropic:  {name:'Anthropic Claude', api:'anthropic', baseUrl:'https://api.anthropic.com', key:true, roles:['brain','coder','vision'], models:['claude-opus-4-5','claude-sonnet-4-5','claude-haiku-4-5']},
  gemini:     {name:'Google Gemini', api:'openai', baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai', key:true, roles:['brain','coder','vision','image'], models:['gemini-2.5-pro','gemini-2.5-flash','imagen-4.0-generate-001']},
  qwen:       {name:'通义千问 DashScope', api:'openai', baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1', key:true, roles:['brain','coder','vision'], models:['qwen-max','qwen-plus','qwen3-coder-plus','qwen-vl-max']},
  moonshot:   {name:'Kimi Moonshot', api:'openai', baseUrl:'https://api.moonshot.cn/v1', key:true, roles:['brain','coder'], models:['kimi-k2-0905-preview','moonshot-v1-32k']},
  zhipu:      {name:'智谱 GLM', api:'openai', baseUrl:'https://open.bigmodel.cn/api/paas/v4', key:true, roles:['brain','coder','vision','image'], models:['glm-4.6','glm-4.5v','cogview-4']},
  siliconflow:{name:'SiliconFlow 硅基流动', api:'openai', baseUrl:'https://api.siliconflow.cn/v1', key:true, roles:['brain','coder','vision','image','tts'], models:['deepseek-ai/DeepSeek-V3','Qwen/Qwen2.5-Coder-32B-Instruct','black-forest-labs/FLUX.1-schnell','Kwai-Kolors/Kolors','FunAudioLLM/CosyVoice2-0.5B']},
  openrouter: {name:'OpenRouter', api:'openai', baseUrl:'https://openrouter.ai/api/v1', key:true, roles:['brain','coder','vision'], models:['anthropic/claude-sonnet-4.5','openai/gpt-5','google/gemini-2.5-pro']},
  ollama:     {name:'Ollama 本地', api:'openai', baseUrl:'http://127.0.0.1:11434/v1', key:false, local:true, roles:['brain','coder','vision'], models:['qwen2.5-coder:7b','llama3.1:8b','llava:7b']},
  lmstudio:   {name:'LM Studio 本地', api:'openai', baseUrl:'http://127.0.0.1:1234/v1', key:false, local:true, roles:['brain','coder','vision'], models:['local-model']},
  comfyui:    {name:'ComfyUI 本地生图', api:'comfyui', baseUrl:'http://127.0.0.1:8188', key:false, local:true, roles:['image'], models:['sd_xl_base_1.0.safetensors','v1-5-pruned-emaonly.safetensors']},
  a1111:      {name:'Stable Diffusion WebUI 本地', api:'a1111', baseUrl:'http://127.0.0.1:7860', key:false, local:true, roles:['image'], models:['default']},
  stability:  {name:'Stability AI', api:'stability', baseUrl:'https://api.stability.ai', key:true, roles:['image'], models:['core','ultra','sd3.5-large']},
  custom:     {name:'自定义 OpenAI 兼容接口', api:'openai', baseUrl:'http://127.0.0.1:8000/v1', key:false, roles:['brain','coder','vision','image','tts'], models:['custom-model']}
};
const ROLES = {
  brain:{name:'主大脑', description:'理解需求、拆解任务、调用工具、审核结果（需要支持函数调用）'},
  coder:{name:'代码模型', description:'C++ / UE Python / Blender Python 专项编写与审查'},
  vision:{name:'视觉模型', description:'看截图、渲染图、参考图并给出判断'},
  image:{name:'生图模型', description:'概念图、贴图、图标、UI 素材'},
  tts:{name:'语音模型', description:'角色配音、旁白、提示音'}
};

function config(settings, id){
  const base = PROVIDERS[id]; if(!base) throw Error('未知模型供应商：'+id);
  const o = settings?.providers?.[id] || {};
  return {...base, id, baseUrl: String(o.baseUrl || base.baseUrl).replace(/\/+$/, ''), enabled: o.enabled !== false, extraModels: Array.isArray(o.models)?o.models:[]};
}

async function http(url, {method='POST', headers={}, body, signal, timeout=180000, raw=false}={}){
  const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(Error('请求超时')), timeout);
  const onAbort = ()=>ctl.abort(Error('已取消')); signal?.addEventListener('abort', onAbort, {once:true});
  try{
    const isForm = typeof FormData!=='undefined' && body instanceof FormData;
    const res = await fetch(url, {method, headers: isForm||body===undefined?headers:{'Content-Type':'application/json', ...headers}, body: body===undefined?undefined:isForm||Buffer.isBuffer(body)||typeof body==='string'?body:JSON.stringify(body), signal: ctl.signal});
    const buf = Buffer.from(await res.arrayBuffer());
    if(!res.ok){ let detail = buf.toString('utf8').slice(0,600).replace(/(sk|key)-[A-Za-z0-9_-]{8,}/g,'***'); throw Object.assign(Error(`HTTP ${res.status}：${detail}`), {status:res.status}); }
    if(raw) return {buffer:buf, type:res.headers.get('content-type')||''};
    try{ return JSON.parse(buf.toString('utf8')); }catch{ throw Error('响应不是 JSON：'+buf.toString('utf8').slice(0,200)); }
  }catch(e){ if(e.name==='AbortError') throw Error(String(ctl.signal.reason?.message||'请求被中止')); throw e; }
  finally{ clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
function authHeaders(p, key){
  if(p.api==='anthropic') return {'x-api-key':key, 'anthropic-version':'2023-06-01'};
  if(p.api==='stability') return {Authorization:'Bearer '+key};
  const h = key ? {Authorization:'Bearer '+key} : {};
  if(p.id==='openrouter') Object.assign(h, {'HTTP-Referer':'https://local.aigw', 'X-Title':'AI Game Workstation'});
  return h;
}

// ---------- 对话（含工具调用） ----------
// 内部消息采用 OpenAI 形状：{role, content, tool_calls:[{id,name,arguments}], tool_call_id}
function toOpenAI(messages){
  return messages.map(m=>{
    if(m.role==='assistant') return {role:'assistant', content:m.content||'', ...(m.tool_calls?.length?{tool_calls:m.tool_calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:typeof c.arguments==='string'?c.arguments:JSON.stringify(c.arguments||{})}}))}:{})};
    if(m.role==='tool') return {role:'tool', tool_call_id:m.tool_call_id, content:String(m.content)};
    if(Array.isArray(m.content)) return {role:m.role, content:m.content.map(part=>part.type==='image'?{type:'image_url',image_url:{url:`data:${part.mime};base64,${part.data}`}}:{type:'text',text:part.text})};
    return {role:m.role, content:m.content};
  });
}
function toAnthropic(messages){
  const system = messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
  const out = [];
  const push = (role, blocks)=>{ const last = out[out.length-1]; if(last && last.role===role) last.content.push(...blocks); else out.push({role, content:blocks}); };
  for(const m of messages){
    if(m.role==='system') continue;
    if(m.role==='assistant'){ const blocks=[]; if(m.content) blocks.push({type:'text',text:m.content}); for(const c of m.tool_calls||[]) blocks.push({type:'tool_use',id:c.id,name:c.name,input:typeof c.arguments==='string'?safeJson(c.arguments):c.arguments||{}}); if(!blocks.length) blocks.push({type:'text',text:'(空)'}); push('assistant', blocks); }
    else if(m.role==='tool') push('user', [{type:'tool_result', tool_use_id:m.tool_call_id, content:String(m.content)}]);
    else push('user', Array.isArray(m.content)?m.content.map(p=>p.type==='image'?{type:'image',source:{type:'base64',media_type:p.mime,data:p.data}}:{type:'text',text:p.text}):[{type:'text',text:String(m.content)}]);
  }
  return {system, messages:out};
}
function safeJson(s){ try{ return JSON.parse(s||'{}'); }catch{ return {_raw:String(s)}; } }

async function chat({settings, vault, provider, model, messages, tools=[], temperature=0.2, maxTokens=4096, signal, json=false}){
  const p = config(settings, provider); if(!p.enabled) throw Error(p.name+' 已在设置中停用');
  const key = vault.get(provider); if(p.key && !key) throw Error(`尚未配置 ${p.name} 的 API Key（模型与密钥页）`);
  if(p.api==='anthropic'){
    const conv = toAnthropic(messages);
    const r = await http(p.baseUrl+'/v1/messages', {headers:authHeaders(p,key), signal, body:{model, max_tokens:maxTokens, temperature, system:conv.system||undefined, messages:conv.messages, ...(tools.length?{tools:tools.map(t=>({name:t.name, description:t.description, input_schema:t.parameters}))}:{})}});
    const text = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const calls = (r.content||[]).filter(b=>b.type==='tool_use').map(b=>({id:b.id, name:b.name, arguments:b.input||{}}));
    return {message:{role:'assistant', content:text, tool_calls:calls}, usage:{input:r.usage?.input_tokens||0, output:r.usage?.output_tokens||0}, stop:r.stop_reason, model:r.model||model};
  }
  if(p.api!=='openai') throw Error(p.name+' 不支持对话');
  const body = {model, messages:toOpenAI(messages), temperature, max_tokens:maxTokens, stream:false};
  if(tools.length) body.tools = tools.map(t=>({type:'function', function:{name:t.name, description:t.description, parameters:t.parameters}}));
  if(json) body.response_format = {type:'json_object'};
  if(/^(o\d|gpt-5)/.test(model)){ delete body.temperature; body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  const r = await http(p.baseUrl+'/chat/completions', {headers:authHeaders(p,key), signal, body});
  const msg = r.choices?.[0]?.message; if(!msg) throw Error('模型没有返回消息');
  const calls = (msg.tool_calls||[]).map(c=>({id:c.id||('call_'+Math.random().toString(36).slice(2)), name:c.function?.name, arguments:safeJson(c.function?.arguments)}));
  return {message:{role:'assistant', content:msg.content||'', tool_calls:calls, reasoning:msg.reasoning_content||undefined}, usage:{input:r.usage?.prompt_tokens||0, output:r.usage?.completion_tokens||0}, stop:r.choices[0].finish_reason, model:r.model||model};
}

async function listModels({settings, vault, provider, signal}){
  const p = config(settings, provider); const key = vault.get(provider);
  if(p.api==='openai'){ const r = await http(p.baseUrl+'/models', {method:'GET', headers:authHeaders(p,key), signal, timeout:20000}); return (r.data||r.models||[]).map(m=>m.id||m.name).filter(Boolean).sort(); }
  if(p.api==='anthropic'){ const r = await http(p.baseUrl+'/v1/models', {method:'GET', headers:authHeaders(p,key), signal, timeout:20000}); return (r.data||[]).map(m=>m.id); }
  if(p.api==='comfyui'){ const r = await http(p.baseUrl+'/object_info/CheckpointLoaderSimple', {method:'GET', signal, timeout:20000}); return r.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]||[]; }
  if(p.api==='a1111'){ const r = await http(p.baseUrl+'/sdapi/v1/sd-models', {method:'GET', signal, timeout:20000}); return r.map(m=>m.title); }
  return p.models;
}

// ---------- 生图 ----------
function sizeOf(size){ const m = /^(\d{3,4})x(\d{3,4})$/.exec(size||''); return m?[+m[1],+m[2]]:[1024,1024]; }
function comfyWorkflow(ckpt, prompt, negative, w, h, seed, steps){
  return {
    '3':{class_type:'KSampler', inputs:{seed, steps, cfg:7, sampler_name:'euler', scheduler:'normal', denoise:1, model:['4',0], positive:['6',0], negative:['7',0], latent_image:['5',0]}},
    '4':{class_type:'CheckpointLoaderSimple', inputs:{ckpt_name:ckpt}},
    '5':{class_type:'EmptyLatentImage', inputs:{width:w, height:h, batch_size:1}},
    '6':{class_type:'CLIPTextEncode', inputs:{text:prompt, clip:['4',1]}},
    '7':{class_type:'CLIPTextEncode', inputs:{text:negative||'blurry, lowres, watermark, text', clip:['4',1]}},
    '8':{class_type:'VAEDecode', inputs:{samples:['3',0], vae:['4',2]}},
    '9':{class_type:'SaveImage', inputs:{filename_prefix:'aigw', images:['8',0]}}
  };
}
async function generateImage({settings, vault, provider, model, prompt, negative='', size='1024x1024', n=1, seed, steps=25, workflowFile, signal}){
  const p = config(settings, provider); const key = vault.get(provider);
  if(p.key && !key) throw Error(`尚未配置 ${p.name} 的 API Key`);
  const [w,h] = sizeOf(size); seed = Number.isInteger(seed)?seed:Math.floor(Math.random()*2**31);
  if(p.api==='a1111'){
    const r = await http(p.baseUrl+'/sdapi/v1/txt2img', {signal, timeout:600000, body:{prompt, negative_prompt:negative, width:w, height:h, steps, seed, batch_size:Math.min(n,4)}});
    return (r.images||[]).map(b=>({buffer:Buffer.from(b,'base64'), mime:'image/png', seed}));
  }
  if(p.api==='comfyui'){
    let graph;
    if(workflowFile){ graph = JSON.parse(fs.readFileSync(workflowFile,'utf8').replaceAll('%PROMPT%', JSON.stringify(prompt).slice(1,-1)).replaceAll('%NEGATIVE%', JSON.stringify(negative).slice(1,-1)).replaceAll('"%SEED%"', String(seed))); }
    else graph = comfyWorkflow(model, prompt, negative, w, h, seed, steps);
    const q = await http(p.baseUrl+'/prompt', {signal, body:{prompt:graph, client_id:'aigw'}});
    const deadline = Date.now()+600000;
    while(Date.now()<deadline){
      if(signal?.aborted) throw Error('已取消');
      await new Promise(r=>setTimeout(r,1500));
      const hist = await http(p.baseUrl+'/history/'+q.prompt_id, {method:'GET', signal, timeout:20000});
      const item = hist[q.prompt_id]; if(!item) continue;
      if(item.status?.status_str==='error') throw Error('ComfyUI 执行失败');
      const imgs = Object.values(item.outputs||{}).flatMap(o=>o.images||[]);
      if(imgs.length){ const out=[]; for(const im of imgs){ const r = await http(`${p.baseUrl}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder||'')}&type=${im.type||'output'}`, {method:'GET', raw:true, signal}); out.push({buffer:r.buffer, mime:r.type||'image/png', seed}); } return out; }
    }
    throw Error('ComfyUI 生成超时');
  }
  if(p.api==='stability'){
    const form = new FormData(); form.append('prompt', prompt); if(negative) form.append('negative_prompt', negative); form.append('output_format','png'); form.append('seed', String(seed));
    const ratio = w===h?'1:1':w>h?(w/h>=1.7?'16:9':'3:2'):(h/w>=1.7?'9:16':'2:3'); form.append('aspect_ratio', ratio);
    const route = model==='ultra'?'ultra':model==='core'?'core':'sd3'; if(route==='sd3') form.append('model', model);
    const r = await http(`${p.baseUrl}/v2beta/stable-image/generate/${route}`, {headers:{...authHeaders(p,key), Accept:'image/*'}, body:form, raw:true, signal, timeout:300000});
    return [{buffer:r.buffer, mime:'image/png', seed}];
  }
  // OpenAI 兼容 /images/generations（OpenAI / 智谱 / SiliconFlow / Gemini / 自定义）
  const body = {model, prompt, n:Math.min(n,4), size};
  if(p.id==='siliconflow'){ Object.assign(body, {image_size:size, batch_size:body.n, seed, num_inference_steps:steps, negative_prompt:negative||undefined}); delete body.size; delete body.n; }
  if(model==='dall-e-3') body.response_format='b64_json';
  const r = await http(p.baseUrl+'/images/generations', {headers:authHeaders(p,key), signal, timeout:300000, body});
  const list = r.data||r.images||[]; const out=[];
  for(const d of list){ if(d.b64_json) out.push({buffer:Buffer.from(d.b64_json,'base64'), mime:'image/png', seed}); else if(d.url){ const img = await http(d.url, {method:'GET', raw:true, signal, timeout:120000}); out.push({buffer:img.buffer, mime:img.type||'image/png', seed}); } }
  if(!out.length) throw Error('生图接口未返回图片');
  return out;
}

// ---------- 语音 ----------
async function speech({settings, vault, provider, model, text, voice='alloy', format='mp3', signal}){
  const p = config(settings, provider); const key = vault.get(provider);
  if(p.api!=='openai') throw Error(p.name+' 不支持语音合成');
  const r = await http(p.baseUrl+'/audio/speech', {headers:authHeaders(p,key), signal, raw:true, timeout:180000, body:{model, input:text, voice, response_format:format}});
  return {buffer:r.buffer, mime:r.type||'audio/mpeg'};
}

function publicCatalog(settings, vault){
  return Object.keys(PROVIDERS).map(id=>{ const c=config(settings,id); return {id, name:c.name, api:c.api, baseUrl:c.baseUrl, defaultBaseUrl:PROVIDERS[id].baseUrl, needsKey:c.key, local:!!c.local, roles:c.roles, models:[...new Set([...c.models, ...c.extraModels])], enabled:c.enabled, hasKey:!!vault.get(id)}; });
}
module.exports = {PROVIDERS, ROLES, config, chat, listModels, generateImage, speech, publicCatalog, toAnthropic, toOpenAI, http};
