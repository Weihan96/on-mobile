import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runNgrok, isOwnedNgrokAgent, validateTunnel, validateNgrokReceipt } from '../scripts/mobile-ngrok.mjs';
import { saveRoute } from '../scripts/mobile-url-for-port.mjs';
let directory, agent, origin, starts, deps;
const url = 'https://owned.ngrok.app';
const wrapper = path.resolve(import.meta.dir, '../scripts/mobile-ngrok.mjs');
const tunnel = () => ({ name: 'on-mobile-origin', public_url: url, config: { addr: 'http://127.0.0.1:43210' }, uri: '/api/tunnels/on-mobile-origin' });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-ngrok-test-'));
  origin = { id: 'origin', port: 43210, status: 'running', expiresAt: new Date(Date.now() + 60000).toISOString() };
  agent = { id: 'agent', directory, port: 4040, bun: process.execPath, argv: [process.execPath, wrapper, 'origin', '43210', '/bin/ngrok'], status: 'running', workerPid: 8888, childPid: process.pid, expiresAt: origin.expiresAt };
  starts = [];
  let monotonic = 0;
  deps = { agentId: 'agent', readService: async id => id === 'agent' ? agent : origin, checkPort: async () => {}, checkOwner: async () => {}, getTunnels: async () => ({ tunnels: [tunnel()] }),
    spawn(executable, args) { const child = new EventEmitter(); child.pid = starts.length + 20000; child.kill = () => queueMicrotask(() => child.emit('exit', 0)); starts.push({ executable, args }); return child; },
    monotonic: () => monotonic,
    async sleep(ms) { monotonic += ms; if (ms === 1000) throw new Error('test monitor complete'); } };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
test('agent ownership binds exact wrapper, origin and port; shared ngrok command rejected', () => {
  expect(isOwnedNgrokAgent(agent, 'origin', 43210)).toBe(true);
  expect(isOwnedNgrokAgent(agent, 'other', 43210)).toBe(false);
  expect(isOwnedNgrokAgent({ ...agent, argv: ['/bin/ngrok', 'start', '--none'] }, 'origin', 43210)).toBe(false);
});
test('tunnel validates exact name, local target, HTTPS and pinned URL', () => {
  expect(validateTunnel(tunnel(), 'origin', 43210, url)).toBe(url);
  for (const bad of [{ ...tunnel(), name: 'foreign' }, { ...tunnel(), public_url: 'https://changed.ngrok.app' }, { ...tunnel(), config: { addr: 'http://foreign:43210' } }]) {
    expect(() => validateTunnel(bad, 'origin', 43210, url)).toThrow();
  }
});
test('HTTP port 80 survives URL canonicalization without accepting other ports', () => {
  const t = { ...tunnel(), config: { addr: 'http://127.0.0.1:80' } };
  expect(validateTunnel(t, 'origin', 80, url)).toBe(url);
  expect(validateTunnel({ ...t, config: { addr: 'http://localhost' } }, 'origin', 80, url)).toBe(url);
  expect(() => validateTunnel(t, 'origin', 43210, url)).toThrow('upstream');
});
test('first delivery really reconnects with --url before persisting ready', async () => {
  await expect(runNgrok('origin', 43210, '/bin/ngrok', deps)).rejects.toThrow('test monitor complete');
  expect(starts).toHaveLength(2); expect(starts[0].args).not.toContain('--url'); expect(starts[1].args.slice(-2)).toEqual(['--url', url]);
  const receipt = JSON.parse(await fs.readFile(path.join(directory, 'ngrok.json'), 'utf8'));
  expect(validateNgrokReceipt(receipt, agent, 'origin', 43210).phase).toBe('ready');
  expect(() => validateNgrokReceipt(receipt, { ...agent, childPid: process.pid + 1 }, 'origin', 43210)).toThrow('not ready');
});
test('restart pins persisted URL instead of requesting a new endpoint', async () => {
  await fs.writeFile(path.join(directory, 'ngrok.json'), JSON.stringify({ originServiceId: 'origin', agentServiceId: 'agent', name: 'on-mobile-origin', target: 'http://127.0.0.1:43210', baseUrl: url, phase: 'discovered' }));
  await expect(runNgrok('origin', 43210, '/bin/ngrok', deps)).rejects.toThrow('test monitor complete');
  expect(starts).toHaveLength(1); expect(starts[0].args.slice(-2)).toEqual(['--url', url]);
});
test('expired or closed origin never starts ngrok', async () => {
  origin.status = 'closed'; await expect(runNgrok('origin', 43210, '/bin/ngrok', deps)).rejects.toThrow('stopped');
  origin.status = 'running'; origin.expiresAt = new Date(Date.now() - 1).toISOString();
  await expect(runNgrok('origin', 43210, '/bin/ngrok', deps)).rejects.toThrow('expired'); expect(starts).toHaveLength(0);
});
test('failure to reacquire same URL cannot produce a ready receipt', async () => {
  deps.getTunnels = async () => ({ tunnels: [{ ...tunnel(), public_url: starts.length === 1 ? url : 'https://other.ngrok.app' }] });
  await expect(runNgrok('origin', 43210, '/bin/ngrok', deps)).rejects.toThrow('pinned URL');
  const receipt = JSON.parse(await fs.readFile(path.join(directory, 'ngrok.json'), 'utf8'));
  expect(receipt.baseUrl).toBe(url); expect(receipt.phase).not.toBe('ready');
});
test('foreign API listener is never accepted', async () => {
  deps.checkOwner = async () => { throw new Error('foreign listener'); };
  await expect(runNgrok('origin', 43210, '/bin/ngrok', deps)).rejects.toThrow('foreign listener');
  expect(await Bun.file(path.join(directory, 'ngrok.json')).exists()).toBe(false);
});
test('route receipt is replaced atomically with no temporary files left', async () => {
  saveRoute({ directory }, { kind: 'ngrok', agentId: 'agent' });
  saveRoute({ directory }, { kind: 'ngrok', agentId: 'agent', removed: true });
  expect(JSON.parse(await fs.readFile(path.join(directory, 'route.json'), 'utf8')).removed).toBe(true);
  expect(await fs.readdir(directory)).toEqual(['route.json']);
});
