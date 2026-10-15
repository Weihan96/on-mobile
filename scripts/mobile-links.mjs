#!/usr/bin/env bun
/** Read-only delivery inventory: actual files, media bytes and shared transport proofs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createManager,readService} from './mobile-service.mjs';
import {loadConfig} from './mobile-delivery.mjs';
import {assertListenerOwned} from './mobile-url-for-port.mjs';
import {isOwnedNgrokAgent, validateNgrokReceipt} from './mobile-ngrok.mjs';
const exec=promisify(execFile);
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
const signal=()=>AbortSignal.timeout(12000);
export function publicURL(text){const u=new URL(text);ensure(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password,'Expected HTTP(S) URL without credentials');return u;}
export async function mediaInfo(filename,{decode=false}={}) {
  const {stdout}=await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',filename],{timeout:15000,maxBuffer:100000});
  const data=JSON.parse(stdout),video=data.streams?.filter(s=>s.codec_type==='video')||[],audio=data.streams?.filter(s=>s.codec_type==='audio')||[];
  const result={video:video.map(s=>s.codec_name),audio:audio.map(s=>s.codec_name),duration:Number(data.format?.duration),compatible:video.length>0&&video.every(s=>s.codec_name==='h264')&&audio.every(s=>s.codec_name==='aac')&&Number(data.format?.duration)>0,decoded:false};
  if(decode){await exec('ffmpeg',['-v','error','-xerror','-i',filename,'-f','null','-'],{timeout:120000,maxBuffer:100000});result.decoded=true;}
  return result;
}
async function prefixBytes(response, limit) {
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let size=0;
  try { while(size<limit){const {value,done}=await reader.read();if(done)break;const piece=value.subarray(0,limit-size);chunks.push(piece);size+=piece.length;} }
  finally {await reader.cancel();}
  return new Uint8Array(Buffer.concat(chunks));
}
export async function probeEntry(url,item,{fetcher=fetch}={}) {
  publicURL(url);
  const headers={'ngrok-skip-browser-warning':'1'};
  const head=await fetcher(url,{method:'HEAD',headers,redirect:'manual',signal:signal()});
  const type=head.headers.get('content-type')||'';
  const result={url,status:head.status,contentType:type,ok:false};
  if(head.status!==200)return {...result,reason:'Endpoint HEAD is not 200'};
  if(item.kind==='html')return {...result,ok:/^text\/html(?:;|$)/i.test(type),reason:/^text\/html(?:;|$)/i.test(type)?undefined:'HTML MIME mismatch'};
  const expected=item.kind==='video'?'video/mp4':item.file?Bun.file(item.file).type.split(';')[0]:'application/octet-stream';
  if(type.split(';')[0].trim().toLowerCase()!==expected.toLowerCase())return {...result,reason:'File MIME mismatch'};
  const response=await fetcher(url,{headers:{...headers,Range:'bytes=0-31'},redirect:'manual',signal:signal()});
  const range=/^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||''),end=Math.min(31,item.size-1);
  result.rangeStatus=response.status;
  const validRange=response.status===206&&range&&Number(range[1])===end&&Number(range[2])===item.size;
  if((item.kind==='video'&&!validRange)||(item.kind==='asset'&&response.status!==200&&!validRange)){
    await response.body?.cancel();return {...result,reason:'Invalid Range status, interval or total'};
  }
  if((response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!==expected.toLowerCase()){
    await response.body?.cancel();return {...result,reason:'File GET MIME mismatch'};
  }
  const bytes=await prefixBytes(response,validRange?end+2:end+1);
  if(bytes.length!==end+1)return {...result,reason:'File prefix length mismatch'};
  if(item.file){const handle=await fs.open(item.file,'r');try{const local=new Uint8Array(bytes.length);await handle.read(local,0,local.length,0);if(!Buffer.from(local).equals(Buffer.from(bytes)))return {...result,reason:'Remote bytes do not match the declared file'};}finally{await handle.close();}}
  return {...result,ok:true};
}
export async function auditConfig(filename,{decode=false,probe=probeEntry,media=mediaInfo}={}) {
  const raw=JSON.parse(await fs.readFile(filename,'utf8')),config=await loadConfig(filename,{allowMissing:true}),entries=[];
  const original=raw.inheritFrom?await readService(raw.inheritFrom):null;
  for(const item of config.files){
    const entry={route:item.route,kind:item.kind,file:item.file,state:'available-local'};
    if(!item.realPath){entry.state=item.sourceRoot&&!await exists(item.sourceRoot)?'source-root-missing':'source-missing';entries.push(entry);continue;}
    const stat=await fs.stat(item.realPath);entry.size=stat.size;
    if(!stat.size){entry.state='empty-source';entries.push(entry);continue;}
    if(original&&Date.now()>=Date.parse(original.expiresAt)){entry.state='expired-original';entries.push(entry);continue;}
    if(item.kind==='video'){
      try{entry.media=await media(item.file,{decode});if(!entry.media.compatible||(item.audioRequired&&!entry.media.audio.length))entry.state='codec-incompatible';}
      catch(error){entry.state='media-unverified';entry.error=error.message;}
    }
    const url=item.url||(raw.publicUrl?new URL(config.basePath+item.route.slice(1),publicURL(raw.publicUrl)).href:null);
    if(url){
      try{entry.http=await probe(url,{...item,size:stat.size});if(!entry.http.ok)entry.state=item.kind==='video'?'video-unavailable':'endpoint-unavailable';else if(entry.state==='available-local')entry.state='available-http';}
      catch(error){entry.state='origin-or-transport-unavailable';entry.error=error.message;}
    }
    entries.push(entry);
  }
  return {readOnly:true,expiresAt:original?.expiresAt||null,entries,playbackTested:false};
}
export async function ngrokInventory(apiPort,{fetcher=fetch}={}){
  ensure(Number.isInteger(apiPort)&&apiPort>0&&apiPort<65536,'Invalid local API port');
  const response=await fetcher(`http://127.0.0.1:${apiPort}/api/tunnels`,{signal:signal()});ensure(response.ok,'ngrok API unavailable');
  return (await response.json()).tunnels.map(t=>({name:t.name,publicUrl:t.public_url,target:t.config?.addr}));
}
export function pinnedTransport(argv,url,port){
  if(!Array.isArray(argv)||path.basename(argv[0]||'')!=='ngrok'||argv[1]!=='http')return false;
  const flag=name=>{const at=argv.indexOf(name);return at>=0?argv[at+1]:argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1);};
  const pinned=flag('--url')||flag('--domain');
  if(!pinned)return false;
  let actual;try{actual=publicURL(pinned.includes('://')?pinned:'https://'+pinned);}catch{return false;}
  const expected=publicURL(url);
  return actual.origin===expected.origin&&actual.pathname==='/'&&argv.some(a=>[String(port),`127.0.0.1:${port}`,`localhost:${port}`,`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(a));
}
export async function auditTransport(config,{inventory=ngrokInventory,read=readService,execute=exec,assertOwner=assertListenerOwned}={}){
  const report={readOnly:true,publicUrl:config.publicUrl,state:'unavailable',gatewayExpiresAt:null};
  try{
    const url=publicURL(config.publicUrl);ensure(url.protocol==='https:'&&url.pathname==='/'&&!url.search&&!url.hash,'Transport URL must be an HTTPS origin');
    const gateway=await read(config.gatewayServiceId);report.gatewayExpiresAt=gateway.expiresAt;
    ensure(gateway.status==='running'&&Date.now()<Date.parse(gateway.expiresAt),'Gateway is not active');
    const tunnels=await inventory(config.apiPort),tunnel=tunnels.find(t=>t.publicUrl===url.origin);
    ensure(tunnel,'Exact public endpoint is absent');
    const target=new URL(tunnel.target?.includes('://')?tunnel.target:'http://'+tunnel.target);
    ensure(target.protocol==='http:'&&['127.0.0.1','localhost'].includes(target.hostname)&&Number(target.port||80)===gateway.port&&target.pathname==='/'&&!target.username&&!target.password&&!target.search&&!target.hash,'Tunnel points to another origin');
    report.state='available-unverified';
    assertOwner(gateway,gateway.port);
    if(config.transportServiceId){
      ensure(config.apiPort===4040,'Managed ngrok wrapper uses API port 4040');
      const agent=await read(config.transportServiceId);
      ensure(isOwnedNgrokAgent(agent,gateway.id,gateway.port)&&agent.status==='running'&&Date.parse(agent.expiresAt)>=Date.parse(gateway.expiresAt),'Managed transport ownership or lifetime mismatch');
      assertOwner(agent,4040);
      const receipt=validateNgrokReceipt(JSON.parse(await fs.readFile(path.join(agent.directory,'ngrok.json'),'utf8')),agent,gateway.id,gateway.port);
      ensure(receipt.baseUrl===url.origin,'Managed transport URL does not match its pinned receipt');
      report.state='verified-supervised';report.reason='Managed wrapper, pinned receipt, origin and listening child tree verified; provider availability still applies';
      return report;
    }
    ensure(typeof config.launchdLabel==='string'&&/^[A-Za-z0-9._-]+$/.test(config.launchdLabel),'A user launchd label is required to verify shared transport supervision');
    const file=path.join(os.homedir(),'Library/LaunchAgents',config.launchdLabel+'.plist');
    ensure((await fs.stat(file)).uid===process.getuid(),'LaunchAgent not owned by current user');
    const {stdout}=await execute('/usr/bin/plutil',['-convert','json','-o','-',file],{timeout:5000});const plist=JSON.parse(stdout);
    ensure(plist.Label===config.launchdLabel&&plist.RunAtLoad&&(plist.KeepAlive===true||plist.KeepAlive?.SuccessfulExit===false),'Agent does not persist/restart under launchd');
    const job=await execute('/bin/launchctl',['print',`gui/${process.getuid()}/${config.launchdLabel}`],{timeout:5000});
    const pid=Number(job.stdout.match(/^\s*pid = (\d+)$/m)?.[1]);ensure(pid>1,'Shared agent not running');
    const listeners=await execute('/usr/sbin/lsof',['-nP',`-iTCP:${config.apiPort}`,'-sTCP:LISTEN','-Fp'],{timeout:5000});
    const pids=[...listeners.stdout.matchAll(/^p(\d+)$/gm)].map(m=>Number(m[1]));ensure(pids.length&&pids.every(p=>p===pid),'API is not owned by this launchd job');
    ensure(pinnedTransport(plist.ProgramArguments,url.origin,gateway.port),'Transport is alive but its startup command does not prove restoration of this exact URL; no durable-link claim');
    report.state='verified-supervised';report.reason='Exact endpoint, origin, API PID and pinned launchd startup verified; provider availability still applies';
  }catch(error){report.reason=error.message;}
  return report;
}
if(import.meta.main){
  try{
    const [command,...args]=process.argv.slice(2);let result;
    if(command==='audit'&&[1,2].includes(args.length)&&(!args[1]||args[1]==='--decode'))result=await auditConfig(path.resolve(args[0]),{decode:args[1]==='--decode'});
    else if(command==='transport'&&args.length===1)result=await auditTransport(JSON.parse(await fs.readFile(args[0],'utf8')));
    else if(command==='inventory'){
      const services=await createManager().list();result={services:services.map(s=>({id:s.id,status:s.status,port:s.port,createdAt:s.createdAt,expiresAt:s.expiresAt,inheritFrom:s.inheritFrom||null})),ngrok:[]};
      for(const port of args.map(Number)){try{result.ngrok.push({apiPort:port,tunnels:await ngrokInventory(port)});}catch(error){result.ngrok.push({apiPort:port,error:error.message});}}
    }else throw new Error('Usage: inventory [LOCAL_NGROK_API_PORT ...] | audit CONFIG [--decode] | transport CONFIG');
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
