#!/usr/bin/env bun
// Explicit macOS-only smoke test. Creates only localhost test services; never touches tunnels.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createManager} from '../scripts/mobile-service.mjs';
import {SCRIPT,readyDelivery,addMount,removeMount} from '../scripts/mobile-delivery.mjs';
import {auditConfig} from '../scripts/mobile-links.mjs';
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
ensure(process.platform==='darwin','This explicit integration test requires macOS launchd');
const parent=path.join(os.homedir(),'.codex/mobile-previews');await fs.mkdir(parent,{recursive:true});
const dir=await fs.mkdtemp(path.join(parent,'delivery-live-')),manager=createManager(),services=[];
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
const waitReady=async id=>{for(let i=0;i<60;i++){try{return await readyDelivery(id);}catch{await Bun.sleep(250);}}throw Error('Readiness failed '+id);};
const waitClosed=async id=>{for(let i=0;i<60;i++){if((await manager.readService(id)).status==='closed')return;await Bun.sleep(250);}throw Error('Cleanup failed '+id);};
const start=async(config,inheritFrom)=>{const s=await manager.start({cwd:dir,port:await freePort(),inheritFrom,argv:[process.execPath,SCRIPT,'serve',config]});services.push(s);await waitReady(s.id);return s;};
const write=async(name,value)=>{const file=path.join(dir,name);await fs.writeFile(file,value);return file;};
const evidence={};
try{
 const home=await write('index.html','<h1>Existing route</h1>');
 const gallery=await write('gallery.html',`<img src='/pixel.svg'><a href='/next.html'>Next</a><video muted src='/clip.mp4'></video>`);
 const image=await write('pixel.svg','<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path d="M0 0h4v4H0z"/></svg>');
 const next=await write('next.html','<h1>Next page</h1>'),video=path.join(dir,'fixture.mp4');
 execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=160x120:r=12','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video]);
 const gatewayConfig=await write('gateway.json',JSON.stringify({version:1,gateway:true,files:[{route:'/',file:home,kind:'html'}]}));
 const leaf={version:1,basePath:'/review/',files:[{route:'/',file:gallery,kind:'html'},{route:'/next.html',file:next,kind:'html'},{route:'/pixel.svg',file:image,kind:'asset'},{route:'/clip.mp4',file:video,kind:'video',audioRequired:true}]};
 const leafConfig=await write('leaf.json',JSON.stringify(leaf));
 const gateway=await start(gatewayConfig),source=await start(leafConfig,gateway.id);
 await addMount(gateway.id,source.id,'/review/');const url=`http://127.0.0.1:${gateway.port}`;
 evidence.audit=await auditConfig(await write('audit.json',JSON.stringify({...leaf,publicUrl:url,inheritFrom:gateway.id})),{decode:true});
 ensure(evidence.audit.entries.every(e=>e.state==='available-http'),'Public-path media/asset audit failed');
 ensure((await(await fetch(url+'/review/')).text()).includes('/review/pixel.svg'),'HTML subpath rewrite failed');
 ensure((await fetch(url+'/review/not-allowed')).status===404,'Whitelist failed');
 const before=await manager.readService(source.id);process.kill(before.childPid,'SIGKILL');
 let after;for(let i=0;i<60;i++){await Bun.sleep(250);try{const r=await readyDelivery(source.id);if(r.service.childPid!==before.childPid){after=r.service;break;}}catch{}}
 ensure(after&&after.expiresAt===before.expiresAt,'Crash restart changed deadline or failed');
 ensure((await fetch(url+'/review/clip.mp4',{headers:{Range:'bytes=0-31'}})).status===206,'Mount did not survive restart');
 evidence.restart={oldPid:before.childPid,newPid:after.childPid,deadlineUnchanged:true};
 // A pending cleanup must not delete B after explicit unmount and prefix reuse.
 await removeMount(gateway.id,source.id,'/review/');
 const replacement=await start(leafConfig,source.id);await addMount(gateway.id,replacement.id,'/review/');
 await manager.stop(source.id);await waitClosed(source.id);
 ensure((await fetch(url+'/review/clip.mp4',{headers:{Range:'bytes=0-31'}})).status===206,'Old cleanup removed replacement lease');
 ensure(replacement.expiresAt===gateway.expiresAt,'Replacement renewed lifetime');
 await manager.stop(replacement.id);await waitClosed(replacement.id);
 ensure((await fetch(url+'/review/clip.mp4')).status===410,'Closed mount still exposed');ensure((await fetch(url+'/')).status===200,'Other gateway route stopped');
 evidence.cleanup={replacementUnaffectedByOldCleanup:true,closedMountStatus:410,existingRouteStatus:200};
}finally{
 for(const service of services.toReversed())await manager.stop(service.id);
 for(const service of services)await waitClosed(service.id);
 evidence.closedServices=services.map(s=>s.id);
 await fs.writeFile(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify({evidence:path.join(dir,'evidence.json'),...evidence},null,2));
