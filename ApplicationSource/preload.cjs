'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('workstation',{
  invoke:(method,args)=>ipcRenderer.invoke('workstation',method,args),
  filePath:file=>webUtils.getPathForFile(file),
  onState:callback=>{const listener=(_e,state)=>callback(state);ipcRenderer.on('state',listener);return()=>ipcRenderer.removeListener('state',listener);},
  onError:callback=>{ipcRenderer.on('appError',(_e,message)=>callback(message));}
});
