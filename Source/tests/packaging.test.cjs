const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {packageDelivery}=require('../tools/package-delivery.cjs');
function fixture(t){const base=path.join(__dirname,'..','.test-temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'pack-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const runtime=path.join(root,'runtime');fs.mkdirSync(path.join(runtime,'resources','app','Data'),{recursive:true});fs.writeFileSync(path.join(runtime,'electron.exe'),'test fixture only');fs.writeFileSync(path.join(runtime,'resources','app','Data','credential.bin'),'dummy secret');return {root,runtime};}
test('packaging works from delivered source without development-machine folders',t=>{
 const {root,runtime}=fixture(t),out=packageDelivery(runtime,path.join(root,'output'));
 assert.ok(fs.existsSync(path.join(out,'Docs')));assert.ok(fs.existsSync(path.join(out,'Application','AI-Game-Workstation.exe')));
 assert.equal(fs.existsSync(path.join(out,'Application','resources','app','Data')),false);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'build-manifest.json')));assert.equal(manifest.version,require('../package.json').version);assert.ok(manifest.sourceHashes.length>10);
});
test('packaging rejects existing output and overlapping runtime without modifying either',t=>{
 const {root,runtime}=fixture(t),out=path.join(root,'output');fs.mkdirSync(out);fs.writeFileSync(path.join(out,'keep'),'unchanged');
 assert.throws(()=>packageDelivery(runtime,out),/nonempty/);assert.throws(()=>packageDelivery(runtime,path.join(runtime,'nested')),/overlap/);assert.equal(fs.readFileSync(path.join(out,'keep'),'utf8'),'unchanged');
});
