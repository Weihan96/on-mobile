import {test,expect,beforeEach,afterEach} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig,createDeliveryHandler,byteRange,createMountFetcher,SCRIPT} from '../scripts/mobile-delivery.mjs';
import {auditConfig,probeEntry,pinnedTransport} from '../scripts/mobile-links.mjs';
let root,config,deadline;
beforeEach(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'mobile-delivery-test-'));deadline=new Date(Date.now()+60000).toISOString();
  await fs.writeFile(path.join(root,'page.html'),`<a href='/gallery/next.html'>Next</a><img src="/image.png"><img src="local.png"><a href='//external.test/x'>External</a><video poster='/image.png' src='/clip.mp4'></video><img srcset='/one.png 1x, /two.png 2x'>`);
  await fs.writeFile(path.join(root,'clip.mp4'),'0123456789abcdef');await fs.writeFile(path.join(root,'image.png'),'image');await fs.writeFile(path.join(root,'private.txt'),'private');
  const file=path.join(root,'config.json');
  await fs.writeFile(file,JSON.stringify({version:1,title:'<safe>',basePath:'/review/',files:[{route:'/gallery/',file:path.join(root,'page.html'),kind:'html',label:'Gallery'},{route:'/clip.mp4',file:path.join(root,'clip.mp4'),kind:'video',label:'Clip'},{route:'/image.png',file:path.join(root,'image.png'),kind:'asset'}]}));
  config=await loadConfig(file);
});
afterEach(async()=>await fs.rm(root,{recursive:true,force:true}));
const request=(route,init)=>new Request('http://localhost'+route,init);
test('allowlist preserves MIME, prevents directory browsing, escapes index and handles methods',async()=>{
 const handler=createDeliveryHandler(config,{expiresAt:deadline});
 expect((await handler(request('/review/private.txt'))).status).toBe(404);
 expect((await handler(request('/review/%2e%2e/private.txt'))).status).not.toBe(200);
 expect((await handler(request('/review/clip.mp4',{method:'POST'}))).status).toBe(405);
 const index=await(await handler(request('/review/'))).text();expect(index).toContain('&lt;safe&gt;');expect(index).toContain('/review/clip.mp4');
 expect((await handler(request('/review/image.png'))).headers.get('content-type')).toContain('image/png');
 const head=await handler(request('/review/clip.mp4',{method:'HEAD'}));expect(head.headers.get('content-type')).toBe('video/mp4');expect(await head.text()).toBe('');
});
test('Range returns correct bytes, suffix and 416 total',async()=>{
 const handler=createDeliveryHandler(config,{expiresAt:deadline});
 const part=await handler(request('/review/clip.mp4',{headers:{Range:'bytes=2-5'}}));expect(part.status).toBe(206);expect(part.headers.get('content-range')).toBe('bytes 2-5/16');expect(await part.text()).toBe('2345');
 const suffix=await handler(request('/review/clip.mp4',{headers:{Range:'bytes=-3'}}));expect(await suffix.text()).toBe('def');
 for(const range of ['bytes=99-','bytes=-0','bytes=5-2','bytes=0-1,4-5']){const r=await handler(request('/review/clip.mp4',{headers:{Range:range}}));expect(r.status).toBe(416);expect(r.headers.get('content-range')).toBe('bytes */16');}
 expect(byteRange('bytes=0-999',16)).toEqual({start:0,end:15});
});
test('HTML single/double quoted attributes and srcset respect subpath, relative paths and external URLs',async()=>{
 const html=await(await createDeliveryHandler(config,{expiresAt:deadline})(request('/review/gallery/'))).text();
 expect(html).toContain('/review/gallery/next.html');expect(html).toContain('/review/image.png');expect(html).toContain('src="local.png"');expect(html).toContain('//external.test/x');expect(html).toContain('/review/one.png 1x, /review/two.png 2x');
});
test('expired or explicitly inactive deliveries expose no bytes',async()=>{
 expect((await createDeliveryHandler(config,{expiresAt:new Date(0).toISOString()})(request('/review/clip.mp4'))).status).toBe(410);
 expect((await createDeliveryHandler(config,{expiresAt:deadline,active:async()=>false})(request('/review/clip.mp4'))).status).toBe(410);
});
test('removed, empty and symlink-swapped sources are not successful media',async()=>{
 const handler=createDeliveryHandler(config,{expiresAt:deadline});
 await fs.writeFile(path.join(root,'clip.mp4'),'');expect((await handler(request('/review/clip.mp4'))).status).toBe(410);
 await fs.unlink(path.join(root,'clip.mp4'));expect((await handler(request('/review/clip.mp4'))).status).toBe(404);
 await fs.symlink(path.join(root,'private.txt'),path.join(root,'clip.mp4'));expect((await handler(request('/review/clip.mp4'))).status).toBe(409);
});
test('audit distinguishes deleted source roots, missing and empty files; valid homepage cannot mask broken video',async()=>{
 const filename=path.join(root,'audit.json');
 await fs.writeFile(path.join(root,'empty.mp4'),'');
 await fs.writeFile(filename,JSON.stringify({version:1,files:[
  {route:'/gone.mp4',file:path.join(root,'deleted','gone.mp4'),sourceRoot:path.join(root,'deleted'),kind:'video'},
  {route:'/missing.mp4',file:path.join(root,'missing.mp4'),sourceRoot:root,kind:'video'},
  {route:'/empty.mp4',file:path.join(root,'empty.mp4'),kind:'video'},
  {route:'/clip.mp4',file:path.join(root,'clip.mp4'),kind:'video',url:'https://example.test/clip.mp4'},
  {route:'/',file:path.join(root,'page.html'),kind:'html',url:'https://example.test/'}]}));
 const report=await auditConfig(filename,{media:async()=>({compatible:true,audio:['aac']}),probe:async(url)=>({ok:!url.endsWith('.mp4'),status:url.endsWith('.mp4')?404:200})});
 expect(report.entries.map(e=>e.state)).toEqual(['source-root-missing','source-missing','empty-source','video-unavailable','available-http']);expect(report.playbackTested).toBe(false);
});
test('video probe rejects fabricated 206 content and verifies matching local bytes',async()=>{
 const item={kind:'video',file:path.join(root,'clip.mp4'),size:16};
 const fetcher=async(url,opts)=>opts.method==='HEAD'?new Response(null,{headers:{'content-type':'video/mp4'}}):new Response('0123456789abcdef',{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-15/16'}});
 expect((await probeEntry('https://example.test/clip.mp4',item,{fetcher})).ok).toBe(true);
 const wrong=async(url,opts)=>opts.method==='HEAD'?fetcher(url,opts):new Response('xxxxxxxxxxxxxxxx',{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-15/16'}});
 expect((await probeEntry('https://example.test/clip.mp4',item,{fetcher:wrong})).reason).toContain('do not match');
});
test('shared transport requires explicit pinned URL and exact origin in startup command',()=>{
 expect(pinnedTransport(['/opt/bin/ngrok','http','127.0.0.1:9999','--url','https://demo.ngrok.app'],'https://demo.ngrok.app',9999)).toBe(true);
 expect(pinnedTransport(['/opt/bin/ngrok','http','9999'],'https://demo.ngrok.app',9999)).toBe(false);
 expect(pinnedTransport(['/opt/bin/ngrok','start','--all'],'https://demo.ngrok.app',9999)).toBe(false);
 expect(pinnedTransport(['/opt/bin/ngrok','http','9998','--url','https://demo.ngrok.app'],'https://demo.ngrok.app',9999)).toBe(false);
});
test('mount proxy preserves subpaths, MIME and Range; removal leaves fallback routes alone',async()=>{
 const origin=Bun.serve({hostname:'127.0.0.1',port:0,fetch:createDeliveryHandler(config,{expiresAt:deadline})});
 try{
  const gateway={id:'gateway',directory:root};await fs.mkdir(path.join(root,'delivery-mounts'));
  const lease={gatewayId:'gateway',originId:'origin',prefix:'/review/',port:origin.port,expiresAt:deadline,removed:false};
  const file=path.join(root,'delivery-mounts','lease.json');await fs.writeFile(file,JSON.stringify(lease));
  const source={id:'origin',port:origin.port,expiresAt:deadline,status:'running',bun:process.execPath,argv:[process.execPath,SCRIPT,'serve',path.join(root,'config.json')]};
  const fetcher=createMountFetcher(gateway,{read:async()=>source,assertOwner:()=>{}});
  const response=await fetcher(request('/review/clip.mp4',{headers:{Range:'bytes=1-3'}}));expect(response.status).toBe(206);expect(response.headers.get('content-type')).toBe('video/mp4');expect(await response.text()).toBe('123');
  expect(await fetcher(request('/other/'))).toBe(null);
  await fs.writeFile(file,JSON.stringify({...lease,removed:true}));expect((await fetcher(request('/review/clip.mp4'))).status).toBe(410);expect(await fetcher(request('/other/'))).toBe(null);
 }finally{origin.stop(true);}
});

test('asset audit rejects HTML fallbacks and verifies actual image bytes',async()=>{
 const item={kind:'asset',file:path.join(root,'image.png'),size:5};
 expect((await probeEntry('https://example.test/image.png',item,{fetcher:async()=>new Response(null,{headers:{'content-type':'text/html'}})})).ok).toBe(false);
 const good=async(url,opts)=>new Response(opts.method==='HEAD'?null:'image',{headers:{'content-type':'image/png'}});
 expect((await probeEntry('https://example.test/image.png',item,{fetcher:good})).ok).toBe(true);
});
test('an active child mount takes precedence over a removed ancestor',async()=>{
 const gateway={id:'gateway',directory:root};await fs.mkdir(path.join(root,'delivery-mounts'));
 await fs.writeFile(path.join(root,'delivery-mounts','a.json'),JSON.stringify({gatewayId:'gateway',originId:'old',prefix:'/review/',expiresAt:deadline,removed:true}));
 await fs.writeFile(path.join(root,'delivery-mounts','b.json'),JSON.stringify({gatewayId:'gateway',originId:'child',prefix:'/review/video/',expiresAt:deadline,port:1,removed:false}));
 let readId;const handler=createMountFetcher(gateway,{read:async(id)=>{readId=id;return {status:'closed'};},assertOwner:()=>{}});
 expect((await handler(request('/review/video/'))).status).toBe(503);expect(readId).toBe('child');
 expect((await handler(request('/review/old/'))).status).toBe(410);
});
