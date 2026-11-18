'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),C=require('../core.cjs');
function packageDelivery(runtime,output,example){
 if(!runtime)throw Error('Provide an Electron distribution directory');
 runtime=fs.realpathSync(runtime);
 const exe=['electron.exe','AI-Game-Workstation.exe'].find(n=>fs.existsSync(path.join(runtime,n)));
 if(!exe)throw Error('Runtime must contain electron.exe or AI-Game-Workstation.exe');
 const out=path.resolve(output||path.join(root,'Delivery','AI-Game-Workstation-2.0-preview'));
 if(C.inside(runtime,out)||C.inside(out,runtime)||out===root||C.inside(out,root))throw Error('Output must not overlap runtime or source');
 if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('Delivery directory is nonempty');
 const docs=[path.join(root,'Docs'),path.join(root,'..','Docs')].find(p=>fs.existsSync(p));
 if(!docs)throw Error('Docs directory is missing');
 const files=['main.cjs','preload.cjs','core.cjs','workflow.cjs','ue-tools.cjs','ue-build.cjs','rig-build.cjs','rig_export.py','media.cjs','assistant.cjs','canvas-selftest.cjs','production-selftest.cjs','blender_task.py','package.json','ui'];
 for(const file of [...files,'tests','tools','Build-Portable.ps1','README.md'])if(!fs.existsSync(path.join(root,file)))throw Error('Missing source: '+file);
 if(example){example=fs.realpathSync(example);const marker=JSON.parse(fs.readFileSync(path.join(example,'.aigw-project.json'),'utf8'));if(marker.schema!==1)throw Error('Invalid example project');if(C.inside(example,out)||C.inside(out,example))throw Error('Example and output overlap');}
 const application=path.join(out,'Application'),source=path.join(out,'Source'),appPath=path.join(application,'resources','app');
 fs.mkdirSync(appPath,{recursive:true});fs.mkdirSync(source,{recursive:true});
 // Exclude the runtime's previous application, Data and credentials.
 for(const entry of fs.readdirSync(runtime))if(entry!=='resources')fs.cpSync(path.join(runtime,entry),path.join(application,entry),{recursive:true});
 if(exe!=='AI-Game-Workstation.exe')fs.renameSync(path.join(application,exe),path.join(application,'AI-Game-Workstation.exe'));
 for(const file of files){fs.cpSync(path.join(root,file),path.join(appPath,file),{recursive:true});fs.cpSync(path.join(root,file),path.join(source,file),{recursive:true});}
 for(const file of ['tests','tools','Build-Portable.ps1','README.md'])fs.cpSync(path.join(root,file),path.join(source,file),{recursive:true});
 fs.cpSync(docs,path.join(out,'Docs'),{recursive:true});fs.copyFileSync(path.join(root,'README.md'),path.join(out,'README.md'));
 if(example)fs.cpSync(example,path.join(out,'ExampleProject'),{recursive:true});
 const hashes=[];function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,ent.name);if(ent.isDirectory())walk(file);else hashes.push({path:path.relative(out,file).replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}
 walk(source);walk(appPath);
 fs.writeFileSync(path.join(out,'build-manifest.json'),JSON.stringify({version:require('../package.json').version,createdAt:C.now(),runtime:'Externally supplied; verify its version before release',validation:'Packaging only; run tests and production acceptance separately',sourceHashes:hashes},null,2));
 return out;
}
module.exports={packageDelivery};
if(require.main===module){try{console.log(packageDelivery(...process.argv.slice(2)));}catch(e){console.error(e.message);process.exitCode=1;}}
