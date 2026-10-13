#!/usr/bin/env bun
/** One origin, one managed ngrok agent. Persist and verify its URL across restarts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readService } from './mobile-service.mjs';
import { getNgrokTunnels } from './lib/mobile-access.mjs';
const SCRIPT = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ensure = (value, message) => { if (!value) throw new Error(message); };
const targetFor = port => `http://127.0.0.1:${port}`;
const nameFor = id => `on-mobile-${id}`;
function httpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
}
export function isOwnedNgrokAgent(agent, originId, port) {
  const a = agent.argv;
  return agent.port === 4040 && Array.isArray(a) && a.length === 5 && a[0] === agent.bun && a[1] === SCRIPT && a[2] === originId && a[3] === String(port) && path.isAbsolute(a[4]);
}
export function validateTunnel(tunnel, originId, port, pinnedUrl) {
  ensure(tunnel?.name === nameFor(originId), 'ngrok tunnel name does not match its origin');
  ensure(httpsUrl(tunnel.public_url), 'ngrok did not return a valid HTTPS origin');
  const addr = new URL(tunnel.config?.addr?.includes('://') ? tunnel.config.addr : `http://${tunnel.config?.addr}`);
  const effectivePort = addr.port || (addr.protocol === 'http:' ? '80' : '443');
  ensure(addr.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(addr.hostname) && effectivePort === String(port) && addr.pathname === '/' && !addr.username && !addr.password && !addr.search && !addr.hash, 'ngrok upstream changed');
  ensure(!pinnedUrl || tunnel.public_url === pinnedUrl, 'ngrok changed the pinned URL');
  return tunnel.public_url;
}
export function validateNgrokReceipt(receipt, agent, originId, port) {
  ensure(isOwnedNgrokAgent(agent, originId, port), 'ngrok agent ownership mismatch');
  ensure(receipt?.originServiceId === originId && receipt.agentServiceId === agent.id && receipt.target === targetFor(port) && receipt.name === nameFor(originId), 'ngrok receipt ownership mismatch');
  ensure(receipt.phase === 'ready' && receipt.workerPid === agent.workerPid && receipt.wrapperPid === agent.childPid && httpsUrl(receipt.baseUrl), 'ngrok receipt is not ready for this worker');
  return receipt;
}
async function atomicReceipt(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function freeApiPort() {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(4040, '127.0.0.1', () => server.close(resolve));
  });
}
function assertApiOwner(pid) {
  const text = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:4040', '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 3000 });
  const pids = [...text.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1]));
  ensure(pids.length && pids.every(p => p === pid), 'ngrok API listener is not this wrapper’s child');
}

export async function runNgrok(originId, port, executable, dependencies = {}) {
  const read = dependencies.readService || readService, spawnChild = dependencies.spawn || spawn;
  const tunnels = dependencies.getTunnels || getNgrokTunnels, checkPort = dependencies.checkPort || freeApiPort;
  const checkOwner = dependencies.checkOwner || assertApiOwner, sleep = dependencies.sleep || pause;
  const monotonic = dependencies.monotonic || (() => performance.now());
  const agentId = dependencies.agentId || process.env.ON_MOBILE_SERVICE_ID;
  ensure(agentId && path.isAbsolute(executable) && Number.isInteger(port) && port > 0 && port < 65536, 'Usage: mobile-ngrok.mjs ORIGIN_ID PORT ABS_NGROK (managed service only)');
  const agent = await read(agentId);
  ensure(isOwnedNgrokAgent(agent, originId, port) && agent.argv[4] === executable, 'Wrapper argv does not match managed ownership');
  const file = path.join(agent.directory, 'ngrok.json');
  let saved;
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved) ensure(saved.originServiceId === originId && saved.agentServiceId === agentId && saved.target === targetFor(port) && saved.name === nameFor(originId) && httpsUrl(saved.baseUrl), 'Invalid persisted ngrok ownership or URL');
  let child = null, ended = true, requested = false, exitPromise;
  const signal = () => { requested = true; };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  const active = async () => {
    const origin = await read(originId), current = await read(agentId);
    ensure(!requested && origin.status === 'running' && current.status === 'running' && origin.port === port && Date.now() < Date.parse(origin.expiresAt) && Date.now() < Date.parse(current.expiresAt), 'Origin or agent stopped, expired, or interrupted');
  };
  const terminate = async () => {
    if (!child || ended) return;
    child.kill('SIGTERM'); await Promise.race([exitPromise, sleep(1500)]);
    if (!ended) { child.kill('SIGKILL'); await Promise.race([exitPromise, sleep(1500)]); }
    ensure(ended, 'Owned ngrok child did not exit');
  };
  const start = async pinnedUrl => {
    await active(); await checkPort(); await active();
    const args = ['http', targetFor(port), '--name', nameFor(originId), ...(pinnedUrl ? ['--url', pinnedUrl] : [])];
    child = spawnChild(executable, args, { stdio: 'inherit', env: process.env }); ended = false;
    exitPromise = new Promise(resolve => { child.once('exit', () => { ended = true; resolve(); }); child.once('error', () => { ended = true; resolve(); }); });
    const deadline = monotonic() + 25000;
    let failure = new Error('ngrok tunnel did not become ready');
    while (monotonic() < deadline) {
      await active(); ensure(!ended, 'ngrok child exited before readiness');
      try {
        await checkOwner(child.pid);
        const found = (await tunnels()).tunnels?.find(t => t.name === nameFor(originId));
        if (found) { validateTunnel(found, originId, port, pinnedUrl); ensure(monotonic() < deadline, 'ngrok readiness deadline elapsed'); return found; }
      } catch (error) { failure = error; }
      await sleep(300);
    }
    throw failure;
  };
  try {
    if (!saved) {
      const first = await start();
      saved = { originServiceId: originId, agentServiceId: agentId, name: nameFor(originId), target: targetFor(port), baseUrl: first.public_url, phase: 'discovered' };
      await atomicReceipt(file, saved);
      await terminate();
    }
    // First delivery also requires a real reconnect using --url. Accounts that
    // cannot reclaim that URL fail before any ready receipt is published.
    await atomicReceipt(file, { ...saved, phase: 'starting' });
    const found = await start(saved.baseUrl);
    await active();
    await atomicReceipt(file, { ...saved, phase: 'ready', uri: found.uri, workerPid: agent.workerPid, wrapperPid: process.pid, ngrokPid: child.pid });
    while (true) {
      await sleep(1000); await active(); ensure(!ended, 'ngrok child exited; launchd will restore its pinned URL');
      await checkOwner(child.pid);
      const found = (await tunnels()).tunnels?.find(t => t.name === nameFor(originId));
      validateTunnel(found, originId, port, saved.baseUrl);
    }
  } finally {
    await terminate();
    process.off('SIGTERM', signal); process.off('SIGINT', signal);
  }
}
if (import.meta.main) {
  try { ensure(process.argv.length === 5, 'Expected origin ID, port and absolute ngrok executable'); await runNgrok(process.argv[2], Number(process.argv[3]), process.argv[4]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
