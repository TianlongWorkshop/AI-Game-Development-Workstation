(function(){
 'use strict';
 const editors=()=>[window.MediaEditor,window.ProductionCanvas,window.ManualRigEditor,window.Workbench].filter(Boolean);
 let pending=null;
 window.DraftGuard={dirty:()=>editors().flatMap(e=>e.dirty?.()||[]),beforeLeave(){if(pending)return pending;pending=(async()=>{const names=window.DraftGuard.dirty();if(!names.length)return true;const response=await window.workstation.invoke('unsavedChoice',{names});if(!response.ok)throw Error(response.error);if(response.value===2)return false;if(response.value===1){for(const e of editors())e.discard?.();return true;}for(const e of editors())await e.saveAll?.();if(window.DraftGuard.dirty().length)throw Error('保存期间发生新的编辑，请再次保存');return true;})().catch(error=>{if(window.toast)window.toast(error.message,true);else alert(error.message);return false;}).finally(()=>pending=null);return pending;}};
})();
