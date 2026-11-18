'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const C=require('../core.cjs');
function fixture(t){const base=path.join(__dirname,'..','.test-temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'regression-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function backend(t){
 const root=fixture(t),store=new C.Store(path.join(root,'data'));
 const electron={app:{setPath(){},setName(){},requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),on(){}},safeStorage:{decryptString:()=> 'fake-test-key'}};
 const context=vm.createContext({require:n=>n==='electron'?electron:require(n.startsWith('./')?path.join(__dirname,'..',n):n),__dirname:path.join(__dirname,'..'),process:{env:{AIGW_DATA_DIR:path.join(root,'data')},on(){}},console,Buffer,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8')+'\n globalThis.harness={handlers,setStore(s){store=s},setRequest(fn){requestDeepseek=fn},planTokens};',context);
 const h=context.harness;h.setStore(store);return {root,store,...h};
}
test('failed project switch preserves active project in memory and disk',t=>{
 const h=backend(t),a=h.store.createProject(h.root,'A'),b=h.store.createProject(h.root,'B');
 h.handlers.projectSwitch({id:a.id});fs.renameSync(b.root,b.root+'-moved');
 assert.throws(()=>h.handlers.projectSwitch({id:b.id}));assert.equal(h.store.data.activeProjectId,a.id);
 assert.equal(JSON.parse(fs.readFileSync(h.store.file)).activeProjectId,a.id);
});
test('failed tool lookup does not consume a valid task plan',t=>{
 const h=backend(t);h.store.createProject(h.root,'A');const p=h.handlers.localPlan({request:'木箱'});
 assert.throws(()=>h.handlers.taskCreate({token:p.token}),/Blender/);assert.ok(h.planTokens.has(p.token));
});
test('late cloud response stays bound to its original project',async t=>{
 const h=backend(t),a=h.store.createProject(h.root,'A'),b=h.store.createProject(h.root,'B');h.handlers.projectSwitch({id:a.id});
 fs.writeFileSync(path.join(h.root,'data','credential.bin'),'test-only');let finish;
 h.setRequest(()=>new Promise(resolve=>finish=resolve));const q=h.handlers.aiQuote({request:'木箱'}),pending=h.handlers.aiPlan({quoteId:q.quoteId});
 h.handlers.projectSwitch({id:b.id});finish({choices:[{message:{content:JSON.stringify({supported:true,recipe:'crate',summary:'test'})}}]});
 const p=await pending;assert.equal(h.planTokens.get(p.token).projectId,a.id);
 assert.throws(()=>h.handlers.taskCreate({token:p.token}),/过期/);
});
test('scan reports inaccessible subdirectory and keeps readable assets',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'blocked'));fs.writeFileSync(path.join(root,'keep.txt'),'keep');
 const original=fs.readdirSync;fs.readdirSync=function(dir,...args){if(path.basename(dir)==='blocked')throw Object.assign(Error('denied'),{code:'EACCES'});return original.call(this,dir,...args);};
 try{const r=C.scanAssets(root);assert.equal(r.assets.length,1);assert.equal(r.errors.length,1);assert.equal(r.errors[0].code,'EACCES');}finally{fs.readdirSync=original;}
});
test('store rejects structurally corrupt collections before saving over them',t=>{
 const root=fixture(t),s=new C.Store(root);s.save();const bad={...s.data,tools:null};fs.writeFileSync(s.file,JSON.stringify(bad));
 const restored=new C.Store(root);assert.ok(Array.isArray(restored.data.tools));assert.ok(restored.data.recoveryNotice);
});
