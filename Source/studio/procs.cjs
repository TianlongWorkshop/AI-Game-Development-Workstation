'use strict';
// 通用进程作业管理：实时日志、取消、超时、持久化日志文件。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');

const jobs = new Map();
let listener = ()=>{};
function onUpdate(fn){ listener = fn; }
function killTree(child){ if(!child||child.exitCode!==null) return; if(process.platform==='win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide:true}, ()=>{}); else child.kill('SIGKILL'); }

/** 运行进程，返回 Promise<{code, log, job}>。 */
function run({kind, title, exe, args=[], cwd, env, logFile, timeout=3600000, onLine, detachedGui=false, projectId}){
  const id = crypto.randomUUID();
  const job = {id, kind, title, exe, args, cwd, status:'running', startedAt:new Date().toISOString(), log:'', exitCode:null, projectId, logFile:logFile||null, stage:''};
  jobs.set(id, job);
  if(logFile){ fs.mkdirSync(path.dirname(logFile), {recursive:true}); fs.writeFileSync(logFile, `> ${exe} ${args.join(' ')}\n`); }
  const promise = new Promise(resolve=>{
    let child;
    try{ child = spawn(exe, args, {cwd, env:{...process.env, ...(env||{})}, windowsHide:!detachedGui, shell:false, stdio:['ignore','pipe','pipe']}); }
    catch(e){ job.status='failed'; job.error=e.message; listener(job); resolve({code:-1, log:e.message, job}); return; }
    job.pid = child.pid; job.child = child;
    let pending = '';
    const append = s=>{
      if(!s) return; job.log = (job.log + s).slice(-200000); if(logFile) try{ fs.appendFileSync(logFile, s); }catch{}
      pending += s; const lines = pending.split(/\r?\n/); pending = lines.pop();
      for(const l of lines){ const m = /AIGW_STAGE:(.*)/.exec(l); if(m) job.stage = m[1].trim(); onLine?.(l, job); }
      throttle(job);
    };
    for(const st of [child.stdout, child.stderr]){ const d = new StringDecoder('utf8'); st.on('data', b=>append(d.write(b))); st.on('end', ()=>append(d.end())); }
    const timer = setTimeout(()=>{ job.timedOut = true; append('\n[工作站] 超时，终止进程\n'); killTree(child); }, timeout);
    child.on('error', e=>{ append('\n[工作站] 启动失败：'+e.message+'\n'); });
    child.on('close', code=>{
      clearTimeout(timer); if(pending){ onLine?.(pending, job); pending=''; }
      job.exitCode = code; job.finishedAt = new Date().toISOString();
      job.status = job.cancelled?'cancelled':job.timedOut?'timeout':code===0?'succeeded':'failed';
      delete job.child; listener(job, true); resolve({code, log:job.log, job});
    });
  });
  listener(job);
  return {id, job, promise};
}
const last = new Map();
function throttle(job){ const t = Date.now(); if(t-(last.get(job.id)||0) > 400){ last.set(job.id, t); listener(job); } }
function cancel(id){ const j = jobs.get(id); if(!j||j.status!=='running') throw Error('作业未在运行'); j.cancelled = true; killTree(j.child); return pub(j); }
function pub(j, withLog=false){ const {child, log, ...rest} = j; return {...rest, tail: log.slice(withLog?-60000:-3000)}; }
function list(){ return [...jobs.values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,60).map(j=>pub(j)); }
function get(id, withLog=true){ const j = jobs.get(id); if(!j) throw Error('作业不存在'); return pub(j, withLog); }
function active(){ return [...jobs.values()].filter(j=>j.status==='running').length; }
function stopAll(){ for(const j of jobs.values()) if(j.status==='running'){ j.cancelled = true; killTree(j.child); } }
module.exports = {run, cancel, list, get, active, stopAll, onUpdate, killTree};
