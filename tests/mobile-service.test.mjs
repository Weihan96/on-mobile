import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createManager, TTL_MS, expiresAt, expired, LABEL_PREFIX } from '../scripts/mobile-service.mjs';

let root, manager, time, jobs, calls, cleanupCode, backend;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-service-test-'));
  time = Date.parse('2026-10-13T01:00:00Z'); jobs = new Map(); calls = []; cleanupCode = 0;
  backend = {
    assertPlatform() {}, async portAvailable(port) { calls.push(['port', port]); },
    async load(file, label) { calls.push(['load', file]); jobs.set(label, { running: true, pid: process.pid }); },
    async job(label) { return jobs.get(label) || null; },
    async unload(label) { calls.push(['unload', label]); jobs.delete(label); },
    async execute(argv, cwd, scope) { calls.push(['cleanup', argv, cwd, scope]); return { code: cleanupCode, error: cleanupCode ? 'transient cleanup error' : null }; },
  };
  manager = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), backend, now: () => time });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function started() {
  const r = await manager.start({ cwd: root, port: 43210, argv: [process.execPath, '--version'] });
  await fs.writeFile(path.join(r.directory, 'runtime.json'), JSON.stringify({ status: 'running', workerPid: process.pid }));
  return manager.readService(r.id);
}

test('lifetime is exactly seven days and expiration boundary is inclusive', () => {
  const createdAt = new Date(time).toISOString(), record = { expiresAt: expiresAt(createdAt) };
  expect(Date.parse(record.expiresAt) - time).toBe(TTL_MS);
  expect(expired(record, time + TTL_MS - 1)).toBe(false);
  expect(expired(record, time + TTL_MS)).toBe(true);
});
test('launchd manifest uses absolute runtime/script and omits inherited secrets', async () => {
  process.env.MOBILE_TEST_SECRET = 'must-not-persist';
  try {
    const r = await started();
    expect(path.isAbsolute(r.bun)).toBe(true); expect(path.isAbsolute(r.script)).toBe(true);
    const plist = await fs.readFile(r.plistPath, 'utf8');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).not.toContain('must-not-persist');
    expect(await fs.readFile(path.join(r.directory, 'service.json'), 'utf8')).not.toContain('MOBILE_TEST_SECRET');
  } finally { delete process.env.MOBILE_TEST_SECRET; }
});
test('readService rejects stale running JSON if launchd job disappeared or PID changed', async () => {
  const r = await started(); jobs.delete(r.label);
  expect((await manager.readService(r.id)).status).toBe('interrupted');
  jobs.set(r.label, { running: true, pid: process.pid + 100 });
  expect((await manager.readService(r.id)).status).toBe('interrupted');
});
test('cleanup registration is separate, idempotent and never extends expiry', async () => {
  const r = await started(); time += 60000;
  const a = await manager.registerCleanup(r.id, ['/usr/bin/true']);
  const b = await manager.registerCleanup(r.id, ['/usr/bin/true']);
  expect(a.id).toBe(b.id); expect((await manager.readService(r.id)).expiresAt).toBe(r.expiresAt);
  expect((await fs.readFile(path.join(r.directory, 'cleanup.json'), 'utf8'))).toContain('pending');
});
test('cleanup registration rejects expired or stopping service', async () => {
  const r = await started(); await manager.stop(r.id);
  await expect(manager.registerCleanup(r.id, ['/usr/bin/true'])).rejects.toThrow('inactive');
  await fs.rm(path.join(r.directory, 'stop-request.json')); time += TTL_MS;
  await expect(manager.registerCleanup(r.id, ['/usr/bin/true'])).rejects.toThrow('inactive');
});
test('cleanup failure remains retryable without deleting artifacts or claiming closed', async () => {
  const r = await started(); await manager.registerCleanup(r.id, ['/usr/bin/true']);
  const media = path.join(r.directory, 'keep.mp4'); await fs.writeFile(media, 'user media');
  cleanupCode = 1; expect(await manager.finish(r.id)).toBe(false);
  expect((await manager.readService(r.id)).status).toBe('cleanup_failed'); expect(jobs.has(r.label)).toBe(true);
  cleanupCode = 0; expect(await manager.finish(r.id)).toBe(true);
  expect((await manager.readService(r.id)).status).toBe('closed');
  expect(await fs.readFile(media, 'utf8')).toBe('user media');
  expect((await manager.readService(r.id)).expiresAt).toBe(r.expiresAt);
  expect(calls.filter(c => c[0] === 'cleanup')[0][3].ON_MOBILE_STATE_ROOT).toBe(path.join(root, 'state'));
});
test('successful cleanups are not repeated when a later cleanup fails', async () => {
  const r = await started(); await manager.registerCleanup(r.id, ['/usr/bin/true', 'first']); await manager.registerCleanup(r.id, ['/usr/bin/true', 'second']);
  let secondFails = true;
  backend.execute = async argv => { calls.push(['cleanup', argv]); return { code: argv[1] === 'second' && secondFails ? 1 : 0 }; };
  expect(await manager.finish(r.id)).toBe(false); secondFails = false; expect(await manager.finish(r.id)).toBe(true);
  expect(calls.filter(c => c[0] === 'cleanup' && c[1][1] === 'first')).toHaveLength(1);
});
test('wrong ownership cannot unload a job or delete its plist', async () => {
  const r = await started(); const file = path.join(r.directory, 'service.json');
  await fs.writeFile(file, JSON.stringify({ ...r, ownerUid: -1 }));
  await expect(manager.stop(r.id)).rejects.toThrow('ownership');
  expect(calls.some(c => c[0] === 'unload')).toBe(false);
  expect(await fs.stat(r.plistPath)).toBeDefined();
});
test('changing plist ownership prevents deletion and retains cleanup_failed', async () => {
  const r = await started(); await fs.writeFile(r.plistPath, 'foreign job content');
  expect(await manager.finish(r.id)).toBe(false);
  expect(await fs.readFile(r.plistPath, 'utf8')).toBe('foreign job content');
  expect((await manager.readService(r.id)).status).toBe('cleanup_failed');
});
test('TTL cannot be extended by tampering with the recorded deadline', async () => {
  const r = await started(); await fs.writeFile(path.join(r.directory, 'service.json'), JSON.stringify({ ...r, expiresAt: new Date(time + 2 * TTL_MS).toISOString() }));
  await expect(manager.readService(r.id)).rejects.toThrow('lifetime');
});
test('expired restart cleans up before ever spawning the server', async () => {
  const r = await started(); time += TTL_MS;
  const m = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), backend, now: () => time, spawn() { throw new Error('expired service must never spawn'); } });
  await m.worker(r.id); expect((await manager.readService(r.id)).status).toBe('closed');
});
test('resource lock allows cleanup registration without manager-lock deadlock', async () => {
  const r = await started();
  await manager.withServiceResourceLock(r.id, () => manager.registerCleanup(r.id, ['/usr/bin/true']));
  expect(JSON.parse(await fs.readFile(path.join(r.directory, 'cleanup.json'), 'utf8'))).toHaveLength(1);
});
test('resource lock serializes concurrent creators', async () => {
  const r = await started(); const order = [];
  await Promise.all([manager.withServiceResourceLock(r.id, async () => { order.push('A'); await new Promise(resolve => setTimeout(resolve, 80)); order.push('a'); }), manager.withServiceResourceLock(r.id, async () => { order.push('B'); order.push('b'); })]);
  expect(['AaBb', 'BbAa']).toContain(order.join(''));
});
test('expired child ignoring SIGTERM is killed only through its owned handle before cleanup', async () => {
  const r = await started(); const child = new EventEmitter(); child.pid = 99999; const signals = [];
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', 0)); };
  const m = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), backend, now: () => time,
    spawn(command, args, opts) { expect(opts.env.ON_MOBILE_SERVICE_ID).toBe(r.id); time += TTL_MS; return child; }, async sleep() {} });
  await m.worker(r.id);
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']); expect((await manager.readService(r.id)).status).toBe('closed');
});
test('worker with occupied port reclaims its resources instead of adopting the listener', async () => {
  const r = await started(); backend.portAvailable = async () => { throw new Error('occupied'); };
  const m = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), backend, now: () => time, spawn() { throw new Error('must not spawn'); } });
  await m.worker(r.id); expect((await manager.readService(r.id)).status).toBe('closed');
});
test('shared resource lock serializes distinct services and nests inside their private locks', async () => {
  const a = await started(), b = await started(), order = [];
  const work = r => manager.withServiceResourceLock(r.id, () => manager.withServiceResourceLock(r.id, async () => {
    order.push(r.id); await new Promise(resolve => setTimeout(resolve, 60)); order.push(r.id);
  }, true));
  await Promise.all([work(a), work(b)]);
  expect(order[0]).toBe(order[1]); expect(order[2]).toBe(order[3]); expect(order[0]).not.toBe(order[2]);
});
test('signal stop survives a cleanup failure and worker restart without respawning', async () => {
  const r = await started(); await manager.registerCleanup(r.id, ['/usr/bin/true']); cleanupCode = 1;
  const child = new EventEmitter(); child.pid = 99999;
  child.kill = () => queueMicrotask(() => child.emit('exit', 0));
  const m = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), backend, now: () => time,
    spawn() { queueMicrotask(() => process.emit('SIGTERM')); return child; },
    async sleep(ms) { if (ms === 1000) throw new Error('simulated worker interruption'); } });
  await expect(m.worker(r.id)).rejects.toThrow('simulated worker interruption');
  expect(JSON.parse(await fs.readFile(path.join(r.directory, 'stop-request.json'), 'utf8')).reason).toBe('Worker termination requested');
  cleanupCode = 0;
  const restarted = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), backend, now: () => time, spawn() { throw new Error('must not respawn'); } });
  await restarted.worker(r.id); expect((await manager.readService(r.id)).status).toBe('closed');
});
test('shared lock remains exclusive across processes and recovers after holder SIGKILL', async () => {
  const r = await started(), ready = path.join(root, 'lock-ready');
  const source = `import fs from 'node:fs/promises';
    import {createManager} from ${JSON.stringify(path.resolve(import.meta.dir, '../scripts/mobile-service.mjs'))};
    await createManager(${JSON.stringify({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents') })}).withServiceResourceLock(${JSON.stringify(r.id)}, async () => {
      await fs.writeFile(${JSON.stringify(ready)}, 'ready'); await new Promise(() => {});
    }, true);`;
  // A live timer keeps this harmless lock-only helper running until this test
  // terminates it. It never bootstraps a launchd job or starts a listener.
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000);' + source], { stdout: 'ignore', stderr: 'pipe' });
  try {
    const deadline = Date.now() + 3000;
    while (!await Bun.file(ready).exists()) {
      if (Date.now() >= deadline) throw new Error('Lock helper did not become ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let entered = false;
    const pending = manager.withServiceResourceLock(r.id, () => { entered = true; }, true);
    await new Promise(resolve => setTimeout(resolve, 80)); expect(entered).toBe(false);
    child.kill('SIGKILL'); await child.exited;
    await pending; expect(entered).toBe(true);
  } finally { child.kill('SIGKILL'); await child.exited; }
});

test('restoration inherits the original deadline through multiple generations', async()=>{
  const original=await started();time+=86400000;
  const restored=await manager.start({cwd:root,port:43211,argv:[process.execPath,'--version'],inheritFrom:original.id});
  expect(restored.version).toBe(2);expect(restored.expiresAt).toBe(original.expiresAt);expect(restored.createdAt).not.toBe(original.createdAt);
  time+=86400000;const next=await manager.start({cwd:root,port:43212,argv:[process.execPath,'--version'],inheritFrom:restored.id});
  expect(next.expiresAt).toBe(original.expiresAt);
  time=Date.parse(original.expiresAt);
  await expect(manager.start({cwd:root,port:43213,argv:[process.execPath,'--version'],inheritFrom:next.id})).rejects.toThrow('cannot renew');
});
test('inherited lifetime cannot be tampered with or made cyclic',async()=>{
  const original=await started();time+=1000;
  const restored=await manager.start({cwd:root,port:43211,argv:[process.execPath,'--version'],inheritFrom:original.id});
  const file=path.join(restored.directory,'service.json');
  await fs.writeFile(file,JSON.stringify({...restored,expiresAt:expiresAt(restored.createdAt)}));
  await expect(manager.readService(restored.id)).rejects.toThrow('lifetime');
  await fs.writeFile(file,JSON.stringify({...restored,inheritFrom:restored.id}));
  await expect(manager.readService(restored.id)).rejects.toThrow('ancestry');
});
