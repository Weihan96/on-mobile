#!/usr/bin/env bun
/** Allowlisted static delivery and owned mounts. Never discovers or serves a directory. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readService, registerCleanup, withServiceResourceLock } from './mobile-service.mjs';
import { assertListenerOwned } from './mobile-url-for-port.mjs';
export const SCRIPT = fileURLToPath(import.meta.url);
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
export async function atomicJSON(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(data, null, 2), {flag:'wx', mode:0o600}); await fs.rename(temp, file); }
  finally { await fs.rm(temp, {force:true}); }
}
export function routePath(value, prefix = false) {
  ensure(typeof value === 'string' && value.startsWith('/') && !/[?#%\\\x00-\x20]/.test(value), 'Route must be an absolute URL path without escapes, query or whitespace');
  ensure(!value.includes('//') && !value.split('/').some(p => p === '.' || p === '..'), 'Ambiguous route path');
  ensure(!prefix || value.endsWith('/'), 'Mount/base path must end in /');
  return value;
}
export async function loadConfig(filename, {allowMissing = false} = {}) {
  ensure(path.isAbsolute(filename), 'Use an absolute config path');
  const bytes = await fs.readFile(filename), raw = JSON.parse(bytes);
  ensure(raw.version === 1 && Array.isArray(raw.files) && raw.files.length > 0, 'Config requires version:1 and a nonempty files array');
  const base = routePath(raw.basePath || '/', true), seen = new Set();
  const files = [];
  for (const item of raw.files) {
    const route = routePath(item.route);
    ensure(!seen.has(route), `Duplicate route ${route}`); seen.add(route);
    ensure(path.isAbsolute(item.file || ''), 'Every allowlisted file must have an absolute path');
    ensure(['html','video','asset'].includes(item.kind), 'File kind must be html, video or asset');
    if (item.sourceRoot) ensure(path.isAbsolute(item.sourceRoot), 'sourceRoot must be absolute');
    let realPath = null;
    try { realPath = await fs.realpath(item.file); ensure((await fs.stat(realPath)).isFile(), 'Allowlisted path is not a regular file'); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    files.push({...item, route, realPath});
  }
  return {version:1, title:String(raw.title || 'Delivery'), basePath:base, gateway:raw.gateway === true, files, digest:hash(bytes)};
}
export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !size || (!match[1] && !match[2])) throw new Error('Unsatisfiable range');
  let start, end;
  if (!match[1]) { const n = Number(match[2]); if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid suffix'); start = Math.max(0,size-n); end=size-1; }
  else { start=Number(match[1]); end=match[2] ? Math.min(Number(match[2]),size-1) : size-1; }
  if (![start,end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) throw new Error('Unsatisfiable range');
  return {start,end};
}
export function prefixed(value, base) {
  return value.startsWith('/') && !value.startsWith('//') && base !== '/' && !value.startsWith(base) ? base.slice(0,-1)+value : value;
}
export function rewriteHTML(response, base) {
  const rewriter = new HTMLRewriter();
  for (const attribute of ['href','src','poster','action']) rewriter.on(`[${attribute}]`, {element(el) {el.setAttribute(attribute,prefixed(el.getAttribute(attribute),base));}});
  rewriter.on('[srcset]', {element(el) { el.setAttribute('srcset',el.getAttribute('srcset').replace(/(^|,\s*)(\/(?!\/)[^\s,]+)/g, (_,separator,url)=>separator+prefixed(url,base))); }});
  return rewriter.transform(response);
}
const mime = item => item.kind === 'video' ? 'video/mp4' : item.kind === 'html' ? 'text/html; charset=utf-8' : Bun.file(item.file).type || 'application/octet-stream';
export function createDeliveryHandler(config, {expiresAt, active = async()=>true, mountFetch} = {}) {
  const map = new Map(config.files.map(item=>[item.route,item]));
  const base = config.basePath;
  return async request => {
    if (Date.now() >= Date.parse(expiresAt) || !await active()) return new Response('Delivery closed',{status:410});
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
    const url = new URL(request.url);
    if (mountFetch) { const mounted = await mountFetch(request); if (mounted) return mounted; }
    if (base !== '/' && url.pathname === base.slice(0,-1)) return new Response(null,{status:308,headers:{Location:base+url.search}});
    if (!url.pathname.startsWith(base)) return new Response('Not found',{status:404});
    let route;
    try { route = routePath(decodeURIComponent('/'+url.pathname.slice(base.length))); } catch { return new Response('Invalid path',{status:400}); }
    if (route === '/' && !map.has('/')) {
      const links = config.files.filter(f=>f.label).map(f=>`<li><a href="${escape(base+f.route.slice(1))}">${escape(f.label)}</a></li>`).join('');
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(config.title)}</title><style>body{max-width:48rem;margin:2rem auto;padding:0 1rem;font:18px/1.6 system-ui}a{display:inline-block;padding:.6rem 0}</style><h1>${escape(config.title)}</h1><ul>${links}</ul></html>`;
      return new Response(request.method==='HEAD'?null:html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    }
    const item=map.get(route);
    if (!item) return new Response('Not found',{status:404});
    try {
      // Exact realpath prevents a subsequently swapped symlink from widening the whitelist.
      if (!item.realPath || await fs.realpath(item.file) !== item.realPath) return new Response('Source changed',{status:409});
      const stat = await fs.stat(item.realPath);
      if (!stat.isFile()) return new Response('Not a file',{status:404});
      if (stat.size === 0) return new Response('Empty source',{status:410});
      const headers = new Headers({'Content-Type':mime(item),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      if (item.kind === 'html') {
        if (stat.size > 10*1024*1024) return new Response('HTML too large',{status:413});
        return rewriteHTML(new Response(request.method==='HEAD'?null:await fs.readFile(item.realPath),{headers}),base);
      }
      headers.set('Accept-Ranges','bytes');
      let range;
      try { range=byteRange(request.headers.get('range'),stat.size); }
      catch { headers.set('Content-Range',`bytes */${stat.size}`); return new Response(null,{status:416,headers}); }
      headers.set('Content-Length',String(range?range.end-range.start+1:stat.size));
      if (range) headers.set('Content-Range',`bytes ${range.start}-${range.end}/${stat.size}`);
      const file=Bun.file(item.realPath);
      return new Response(request.method==='HEAD'?null:range?file.slice(range.start,range.end+1):file,{status:range?206:200,headers});
    } catch(error) { if (['ENOENT','ENOTDIR'].includes(error.code)) return new Response('Source missing',{status:404}); throw error; }
  };
}
export function isDeliveryService(service) {return service.argv?.length===4 && service.argv[0]===service.bun && service.argv[1]===SCRIPT && service.argv[2]==='serve' && path.isAbsolute(service.argv[3]);}
export async function readyDelivery(id) {
  const service=await readService(id);
  ensure(isDeliveryService(service) && service.status==='running' && Date.now()<Date.parse(service.expiresAt),'Expected running managed delivery service');
  assertListenerOwned(service,service.port);
  const config=await loadConfig(service.argv[3],{allowMissing:true});
  const ready=JSON.parse(await fs.readFile(path.join(service.directory,'delivery-ready.json'),'utf8'));
  ensure(ready.workerPid===service.workerPid && ready.childPid===service.childPid && ready.digest===config.digest,'Delivery receipt is stale or config changed');
  return {service,config};
}
function mountsDirectory(service) {return path.join(service.directory,'delivery-mounts');}
function mountFilename(service,prefix,originId) {return path.join(mountsDirectory(service),hash(JSON.stringify([prefix,originId]))+'.json');}
export async function removeMount(gatewayId,originId,prefix) {
  routePath(prefix,true); const gateway=await readService(gatewayId);
  return withServiceResourceLock(gatewayId,async()=>{
    const filename=mountFilename(gateway,prefix,originId); let lease;
    try {lease=JSON.parse(await fs.readFile(filename,'utf8'));} catch(e) {if(e.code==='ENOENT')return; throw e;}
    ensure(lease.gatewayId===gatewayId && lease.originId===originId && lease.prefix===prefix,'Mount ownership changed; retain for inspection');
    await atomicJSON(filename,{...lease,removed:true});
  });
}
export async function addMount(gatewayId,originId,prefix) {
  routePath(prefix,true); ensure(prefix!=='/' && gatewayId!==originId,'A mount requires distinct services and a non-root prefix');
  const host=await readyDelivery(gatewayId), source=await readyDelivery(originId);
  ensure(host.config.gateway,'Gateway opt-in is required');
  ensure(source.config.basePath===prefix && !source.config.gateway,'Source must be a leaf delivery with the exact mount basePath');
  ensure(Date.parse(source.service.expiresAt)<=Date.parse(host.service.expiresAt),'Choose a gateway covering the original delivery deadline; do not change the inherited source deadline to fit it');
  return withServiceResourceLock(gatewayId,async()=>{
    await readyDelivery(gatewayId); await readyDelivery(originId);
    ensure(!host.config.files.some(f=>f.route===prefix.slice(0,-1)||f.route.startsWith(prefix)),'Mount shadows an existing allowlisted route');
    ensure(host.config.basePath==='/', 'Gateway must use root basePath');
    const directory=mountsDirectory(host.service);await fs.mkdir(directory,{recursive:true,mode:0o700});
    for(const name of await fs.readdir(directory)) {
      if(!name.endsWith('.json'))continue;
      const other=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
      if(other.removed)continue;
      if(other.prefix===prefix && other.originId===originId)return other;
      ensure(!other.prefix.startsWith(prefix)&&!prefix.startsWith(other.prefix),'Mount collides with an existing lease');
    }
    // Register before publication. Cleanup serializes on this same gateway lock.
    await registerCleanup(originId,[process.execPath,SCRIPT,'unmount',gatewayId,originId,prefix]);
    await readyDelivery(originId); await readyDelivery(gatewayId);
    const lease={version:1,gatewayId,originId,prefix,port:source.service.port,expiresAt:source.service.expiresAt,removed:false};
    await atomicJSON(mountFilename(host.service,prefix,originId),lease);
    return lease;
  });
}
export function createMountFetcher(gateway,{read=readService,assertOwner=assertListenerOwned}={}) {
  return async request=>{
    let entries;try{entries=await fs.readdir(mountsDirectory(gateway));}catch(e){if(e.code==='ENOENT')return null;throw e;}
    const url=new URL(request.url);
    const leases=await Promise.all(entries.filter(n=>n.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile(path.join(mountsDirectory(gateway),name),'utf8'))));
    // Active descendants must win over a removed ancestor's tombstone.
    leases.sort((a,b)=>Number(a.removed)-Number(b.removed)||b.prefix.length-a.prefix.length);
    for(const lease of leases) {
      if(url.pathname!==lease.prefix.slice(0,-1)&&!url.pathname.startsWith(lease.prefix))continue;
      if(lease.removed || lease.gatewayId!==gateway.id || Date.now()>=Date.parse(lease.expiresAt))return new Response('Mount closed',{status:410});
      const source=await read(lease.originId);
      if(!isDeliveryService(source)||source.status!=='running'||source.port!==lease.port||source.expiresAt!==lease.expiresAt)return new Response('Source unavailable',{status:503});
      assertOwner(source,source.port);
      const headers=new Headers();for(const key of ['range','if-range','accept'])if(request.headers.has(key))headers.set(key,request.headers.get(key));
      // Preserve the path: the source serves its configured basePath. No blind HTML regex proxy.
      const upstream=await fetch(`http://127.0.0.1:${source.port}${url.pathname}${url.search}`,{method:request.method,headers,redirect:'manual',signal:AbortSignal.timeout(10000)});
      const clean=new Headers(upstream.headers);for(const key of ['connection','transfer-encoding','keep-alive','set-cookie'])clean.delete(key);
      return new Response(request.method==='HEAD'?null:upstream.body,{status:upstream.status,headers:clean});
    }
    return null;
  };
}
async function serve(configPath) {
  const service=await readService(process.env.ON_MOBILE_SERVICE_ID);
  ensure(isDeliveryService(service)&&service.argv[3]===configPath,'Delivery must be started by mobile-service.mjs');
  const config=await loadConfig(configPath);
  const active=async()=>{const s=await readService(service.id);return s.status==='running' && s.workerPid===service.workerPid;};
  const fetch=createDeliveryHandler(config,{expiresAt:service.expiresAt,active,mountFetch:config.gateway?createMountFetcher(service):undefined});
  const server=Bun.serve({hostname:'127.0.0.1',port:service.port,fetch:async r=>{try{return await fetch(r);}catch{return new Response('Delivery unavailable',{status:503});}}});
  await atomicJSON(path.join(service.directory,'delivery-ready.json'),{digest:config.digest,workerPid:service.workerPid,childPid:process.pid});
  const stop=()=>{server.stop(true);process.exit(0);};process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(import.meta.main) {
  try {
    const [command,...args]=process.argv.slice(2);
    if(command==='serve'&&args.length===1)await serve(args[0]);
    else if(command==='mount'&&args.length===3)console.log(JSON.stringify(await addMount(...args),null,2));
    else if(command==='unmount'&&args.length===3)await removeMount(...args);
    else throw new Error('Usage: serve ABS_CONFIG | mount GATEWAY_ID ORIGIN_ID /prefix/ | unmount GATEWAY_ID ORIGIN_ID /prefix/');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
