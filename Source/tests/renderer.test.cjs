'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),C=require('../core.cjs');
function renderer(){
 const nodes=new Map(),events={},callbacks={};
 function node(id){if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',value:'',scrollTop:0,focus(){},setSelectionRange(){},remove(){nodes.delete(id)},scrollIntoView(){}});return nodes.get(id);}
 ['app','inspector','bottom-panel','content','dialog-root','toasts'].forEach(node);
 const document={querySelector:s=>nodes.get(s.replace(/^#/,''))||null,getElementById:id=>nodes.get(id),activeElement:null,addEventListener:(name,fn)=>events[name]=fn};
 const window={workstation:{invoke:()=>new Promise(()=>{}),onState:fn=>callbacks.state=fn,onError:fn=>callbacks.error=fn}};
 const context=vm.createContext({window,document,console,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8')+`\nglobalThis.h={set(s){S=s},getPlan(){return plan},getRecipe(){return selectedRecipe},setPlan(p){plan=p},setPage(p){page=p},setPreview(v){selectedAsset=v},ticket(){return previewTicket},action,render,planHTML,loadPreview};`,context);
 const state={version:'test',projects:[{id:'a',name:'A',root:'A'}],activeProjectId:'a',tools:[],tasks:[],calls:[],settings:{dailyBudget:1,callBudget:.02},assets:[],scan:{errors:[]},discovery:{errors:[]},hasKey:false,pricing:C.pricing,recipes:C.recipes,blueprint:{reserved:[]}};
 context.h.set(state);return {h:context.h,state,nodes,node,events,callbacks,window};
}
test('project state updates refresh the visible workspace and clear stale plans',()=>{
 const r=renderer();r.h.render();r.h.setPlan({projectId:'a',summary:'old'});
 r.callbacks.state({...r.state,activeProjectId:'b',projects:[...r.state.projects,{id:'b',name:'NEW_PROJECT',root:'B'}]});
 assert.equal(r.h.getPlan(),null);assert.match(r.nodes.get('app').innerHTML,/NEW_PROJECT/);
});
test('task progress alone does not rebuild the workspace or destroy the preview',()=>{
 const r=renderer();r.h.render();const ticket=r.h.ticket();
 r.callbacks.state({...r.state,tasks:[{id:'t',projectId:'a',name:'test',status:'running',progress:20,logs:[]}]});
 assert.equal(r.h.ticket(),ticket);assert.match(r.nodes.get('bottom-panel').innerHTML,/20%/);
});
test('request edits invalidate the displayed execution plan',()=>{
 const r=renderer();r.node('.plan');r.h.setPlan({projectId:'a',summary:'old'});
 r.events.input({target:{id:'request',value:'a different request'}});assert.equal(r.h.getPlan(),null);assert.equal(r.nodes.has('.plan'),false);
});
test('selected recipe can be toggled off for automatic template selection',async()=>{
 const r=renderer();await r.h.action('select-recipe',{recipe:'crate'});assert.equal(r.h.getRecipe(),'crate');
 await r.h.action('select-recipe',{recipe:'crate'});assert.equal(r.h.getRecipe(),null);
});
test('late asset response cannot mount a viewer on a detached preview panel',async()=>{
 const r=renderer(),old=r.node('preview-area');r.h.setPreview('asset');let finish,viewers=0;
 r.window.workstation.invoke=()=>new Promise(resolve=>finish=resolve);r.window.createGLBViewer=()=>viewers++;
 const pending=r.h.loadPreview();r.nodes.set('preview-area',{innerHTML:'new panel'});
 finish({ok:true,value:{kind:'glb',data:'unused'}});await pending;
 assert.equal(viewers,0);assert.equal(old.innerHTML,'');assert.equal(r.nodes.get('preview-area').innerHTML,'new panel');
});
test('settings drafts survive unrelated tool discovery refreshes',()=>{
 const r=renderer();r.h.setPage('settings');r.node('api-key').value='draft-test-value';r.node('daily-budget').value='2';
 r.callbacks.state({...r.state,tools:[{id:'b',kind:'blender',status:'verified',path:'test',version:'test'}]});
 assert.equal(r.node('api-key').value,'draft-test-value');assert.equal(r.node('daily-budget').value,'2');
});
