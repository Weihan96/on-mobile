import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createManager } from '../scripts/mobile-service.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function fixture(work, { prepare, readyPath = '/old' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-update-process-'));
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
  const file = path.join(root, 'app.mjs');
  await fs.writeFile(file, "const [port,version]=process.argv.slice(2); if(version==='bad') process.exit(1); Bun.serve({hostname:'127.0.0.1',port:Number(port),fetch:r=>new Response(version,{status:new URL(r.url).pathname==='/'+version?200:404})});");
  const jobs = new Map(), children = []; let clock = Date.now();
  const backend = { assertPlatform() {}, async portAvailable() {}, async load(_, label) { jobs.set(label, { running: true, pid: process.pid }); }, async job(label) { return jobs.get(label); }, async unload(label) { jobs.delete(label); }, async execute() { throw new Error('Update must not run route cleanup'); },
    async probe(_, p) { try { const response = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(200) }); const text = await response.text(); return response.ok && text === p.slice(1); } catch { return false; } } };
  const { spawn } = await import('node:child_process');
  const options = { stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), threadId: 'owner', backend, now: () => clock, sleep: async ms => { clock += ms; await pause(ms === 1000 ? 10 : 5); },
    spawn(exe,args,opts) { const child = spawn(exe,args,opts); children.push(child); return child; } };
  const manager = createManager(options);
  const service = await manager.start({ cwd: root, port, argv: [process.execPath, file, String(port), 'old'] });
  if (prepare) await prepare(service, { root, file, port });
  const worker = manager.worker(service.id); let workerFailure; worker.catch(e => { workerFailure = e; });
  async function until(predicate) { const end = Date.now() + 5000; while (!await predicate()) { if (workerFailure) throw workerFailure; if (Date.now() > end) throw new Error('Test observation timeout'); await pause(10); } }
  try {
    await until(async () => (await manager.readService(service.id)).childPid && await backend.probe(service, readyPath));
    await work({ manager, options, service, root, file, port, until, backend });
  } finally {
    await manager.stop(service.id); await worker.catch(() => {});
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('real app child update keeps service identity and expiry, then explicit rollback restores old health path', async () => fixture(async t => {
  const original = await t.manager.readService(t.service.id), originalManifest = await fs.readFile(path.join(t.service.directory, 'service.json'));
  const request = await t.manager.update(t.service.id, { cwd: t.root, argv: [process.execPath, t.file, String(t.port), 'new'], readyPath: '/new', previousReadyPath: '/old' });
  await t.until(async () => (await t.manager.readService(t.service.id)).updateResult?.id === request.updateId);
  const updated = await t.manager.readService(t.service.id); expect(updated.updateResult.phase).toBe('ready'); expect(updated.childPid).not.toBe(original.childPid);
  expect(updated.expiresAt).toBe(original.expiresAt); expect(updated.id).toBe(original.id); expect(updated.port).toBe(original.port);
  expect((await fs.readFile(path.join(t.service.directory, 'service.json'))).equals(originalManifest)).toBe(true);
  const rollback = await t.manager.update(t.service.id, { rollback: true });
  await t.until(async () => (await t.manager.readService(t.service.id)).updateResult?.id === rollback.updateId);
  expect((await t.manager.readService(t.service.id)).updateResult.phase).toBe('ready'); expect(await t.backend.probe(t.service, '/old')).toBe(true);
}), 15000);
test('real failed candidate rolls back without route cleanup and rejects foreign chat updates', async () => fixture(async t => {
  const foreign = createManager({ ...t.options, threadId: 'another-chat' });
  await expect(foreign.update(t.service.id, { cwd: t.root, argv: ['/bin/false'] })).rejects.toThrow('owning chat');
  const request = await t.manager.update(t.service.id, { cwd: t.root, argv: [process.execPath, t.file, String(t.port), 'bad'], readyPath: '/bad', previousReadyPath: '/old' });
  await t.until(async () => (await t.manager.readService(t.service.id)).updateResult?.id === request.updateId);
  const result = await t.manager.readService(t.service.id); expect(result.updateResult.phase).toBe('rolled-back'); expect(result.status).toBe('running');
  expect(await t.backend.probe(t.service, '/old')).toBe(true);
  expect(result.expiresAt).toBe(t.service.expiresAt);
}), 15000);
test('old live supervisors reject update before touching the app', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'old-origin-worker-'));
  const backend = { assertPlatform() {}, async portAvailable() {}, async load() {}, async job() { return { running: true, pid: process.pid }; }, async probe() { throw new Error('must not probe unsupported worker'); } };
  try {
    const manager = createManager({ stateRoot: path.join(root, 'state'), agentsRoot: path.join(root, 'agents'), threadId: 'owner', backend });
    const service = await manager.start({ cwd: root, port: 3215, argv: ['/usr/bin/true'] });
    await fs.writeFile(path.join(service.directory, 'runtime.json'), JSON.stringify({ status: 'running', workerPid: process.pid, childPid: 9999 }));
    await expect(manager.update(service.id, { cwd: root, argv: ['/usr/bin/true'] })).rejects.toThrow('update-capable');
    expect(await fs.exists(path.join(service.directory, 'update-request.json'))).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('stop during a real failed candidate prevents rollback and retains the original deadline', async () => fixture(async t => {
  const request = await t.manager.update(t.service.id, { cwd: t.root, argv: [process.execPath, t.file, String(t.port), 'bad'], readyPath: '/bad', previousReadyPath: '/old' });
  await t.until(async () => (await t.manager.readService(t.service.id)).status === 'maintaining');
  await t.manager.stop(t.service.id);
  await t.until(async () => (await t.manager.readService(t.service.id)).updateResult?.id === request.updateId);
  const after = await t.manager.readService(t.service.id);
  expect(after.updateResult.phase).toBe('aborted'); expect(after.expiresAt).toBe(t.service.expiresAt);
  expect(await t.backend.probe(t.service, '/old')).toBe(false);
}), 15000);

test('committed crash journal restarts the candidate and never claims the original was retained', async () => {
  const id = crypto.randomUUID();
  await fixture(async t => {
    await t.until(async () => (await t.manager.readService(t.service.id)).updateResult?.id === id);
    expect((await t.manager.readService(t.service.id)).updateResult.phase).toBe('recovered-commit');
    expect(await t.backend.probe(t.service, '/new')).toBe(true);
  }, { readyPath: '/new', prepare: async (s, { root, file, port }) => {
    await fs.writeFile(path.join(s.directory, 'deployment.json'), JSON.stringify({ updateId: id, active: { cwd: root, argv: [process.execPath, file, String(port), 'new'], readyPath: '/new' }, previous: { cwd: root, argv: s.argv, readyPath: '/old' } }));
    await fs.writeFile(path.join(s.directory, 'update-request.json'), JSON.stringify({ id, serviceId: s.id, ownerThreadId: 'owner', workerPid: process.pid, workerInstance: 'old-incarnation', expiresAt: s.expiresAt, requestedAt: new Date().toISOString() }));
  } });
}, 15000);
test('transport preflight failure after queuing leaves the healthy app and supervisor running', async () => fixture(async t => {
  const originalProbe = t.backend.probe;
  t.backend.probe = async (...args) => {
    const healthy = await originalProbe(...args);
    await fs.writeFile(path.join(t.service.directory, 'route.json'), JSON.stringify({ kind: 'ngrok', agentId: 'invalid' }));
    return healthy;
  };
  const before = await t.manager.readService(t.service.id);
  const request = await t.manager.update(t.service.id, { cwd: t.root, argv: [process.execPath, t.file, String(t.port), 'new'], readyPath: '/new', previousReadyPath: '/old' });
  t.backend.probe = originalProbe;
  await t.until(async () => (await t.manager.readService(t.service.id)).updateResult?.id === request.updateId);
  const after = await t.manager.readService(t.service.id);
  expect(after.updateResult.phase).toBe('rejected'); expect(after.workerPid).toBe(before.workerPid); expect(after.childPid).toBe(before.childPid); expect(after.status).toBe('running');
  expect(await originalProbe(t.service, '/old')).toBe(true);
}), 15000);
