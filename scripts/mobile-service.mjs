#!/usr/bin/env bun
/** Task-independent, seven-day macOS launchd previews. No user content is deleted. */
import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LABEL_PREFIX = 'com.codex.on-mobile.';
const SCRIPT = fileURLToPath(import.meta.url);
const ID = /^[a-f0-9-]{36}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const exists = async file => { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
export const expiresAt = createdAt => new Date(Date.parse(createdAt) + TTL_MS).toISOString();
export const expired = (record, now = Date.now()) => now >= Date.parse(record.expiresAt);

async function atomicJSON(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
let flock;
async function locked(directory, operation) {
  if (!flock) {
    const { dlopen, FFIType } = await import('bun:ffi');
    flock = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols.flock;
  }
  // Never unlink: all contenders must lock the same inode. The kernel releases
  // ownership when this handle closes, including an uncatchable process exit.
  const handle = await fs.open(path.join(directory, '.lockfile'), 'a', 0o600);
  const deadline = Date.now() + 10000;
  let acquired = false;
  try {
    while (flock(handle.fd, 2 | 4) !== 0) {
      ensure(Date.now() < deadline, 'Service state lock busy or unavailable; retry later');
      await pause(50);
    }
    acquired = true;
    return await operation();
  } finally {
    if (acquired) flock(handle.fd, 8);
    await handle.close();
  }
}
async function executable(command, cwd) {
  ensure(typeof command === 'string' && command.length > 0, 'Command is required');
  const candidates = command.includes('/') ? [path.resolve(cwd, command)] : (process.env.PATH || '/usr/bin:/bin').split(':').map(p => path.join(p, command));
  for (const candidate of candidates) {
    try { await fs.access(candidate, F.X_OK); return await fs.realpath(candidate); } catch { /* try next executable */ }
  }
  throw new Error(`Executable not found: ${command}`);
}
function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function plist(record, stateRoot, agentsRoot) {
  const args = [record.bun, record.script, '_worker', record.id, '--state-root', stateRoot, '--agents-root', agentsRoot];
  const safePath = [...new Set([path.dirname(record.bun), path.dirname(record.argv[0]), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(record.label)}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(record.directory)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.homedir())}</string><key>PATH</key><string>${xml(safePath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StartInterval</key><integer>60</integer><key>ThrottleInterval</key><integer>10</integer>
<key>AbandonProcessGroup</key><false/><key>ExitTimeOut</key><integer>20</integer>
<key>StandardOutPath</key><string>${xml(path.join(record.directory, 'worker.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(record.directory, 'worker.log'))}</string>
</dict></plist>\n`;
}
function systemBackend(uid) {
  const target = label => `gui/${uid}/${label}`;
  return {
    assertPlatform() { ensure(process.platform === 'darwin', 'mobile-service requires macOS launchd'); },
    portAvailable,
    async load(file) { await exec('/bin/launchctl', ['bootstrap', `gui/${uid}`, file]); },
    async job(label) {
      try {
        const { stdout } = await exec('/bin/launchctl', ['print', target(label)]);
        const pid = Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]);
        return { running: /state = running/.test(stdout) && pid > 1, pid: pid || null };
      } catch (e) {
        if (e.code === 113 || /Could not find service|Could not find specified service/.test(e.stderr || '')) return null;
        throw e;
      }
    },
    async unload(label) {
      const job = await this.job(label);
      if (!job) return;
      if (job.pid === process.pid) {
        // Exit this worker normally; a short, separate process removes only its job.
        const reaper = spawn('/bin/launchctl', ['bootout', target(label)], { detached: true, stdio: 'ignore' });
        reaper.unref();
      } else await exec('/bin/launchctl', ['bootout', target(label)]);
    },
    async execute(argv, cwd, scope = {}) {
      try { await exec(argv[0], argv.slice(1), { cwd, timeout: 20000, maxBuffer: 256000, env: { HOME: os.homedir(), PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', ...scope } }); return { code: 0 }; }
      catch (e) { return { code: e.code || 1, error: String(e.stderr || e.message).slice(0, 2000) }; }
    },
  };
}

export function createManager(options = {}) {
  const uid = options.uid ?? process.getuid();
  const stateRoot = path.resolve(options.stateRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state/on-mobile/services'));
  const agentsRoot = path.resolve(options.agentsRoot || path.join(os.homedir(), 'Library/LaunchAgents'));
  const now = options.now || Date.now;
  const backend = options.backend || systemBackend(uid);
  const spawnChild = options.spawn || spawn;
  const sleep = options.sleep || pause;
  const directoryFor = id => { ensure(ID.test(id), 'Invalid service ID'); return path.join(stateRoot, id); };
  async function manifest(id, ancestors = new Set()) {
    ensure(!ancestors.has(id) && ancestors.size < 64, 'Invalid lifetime ancestry');
    ancestors.add(id);
    const directory = directoryFor(id);
    const r = await readJSON(path.join(directory, 'service.json'));
    ensure(r.id === id && r.ownerUid === uid && r.label === LABEL_PREFIX + id && r.directory === directory && r.plistPath === path.join(agentsRoot, r.label + '.plist'), 'Service ownership mismatch; refusing operation');
    let deadline = expiresAt(r.createdAt);
    if (r.inheritFrom) {
      ensure(r.version === 2, 'Invalid inherited service version');
      const prior = await manifest(r.inheritFrom, ancestors);
      deadline = new Date(Math.min(Date.parse(deadline), Date.parse(prior.expiresAt))).toISOString();
    }
    ensure(r.expiresAt === deadline, 'Invalid service lifetime; refusing operation');
    return r;
  }
  async function runtime(r) {
    try { return await readJSON(path.join(r.directory, 'runtime.json')); } catch (e) { if (e.code === 'ENOENT') return { status: 'starting' }; throw e; }
  }
  async function writeRuntime(r, value) { await atomicJSON(path.join(r.directory, 'runtime.json'), { ...value, updatedAt: new Date(now()).toISOString() }); }
  async function readService(id) {
    const r = await manifest(id), live = await runtime(r), job = await backend.job(r.label);
    let status = live.status;
    if (status === 'running' && (!job?.running || job.pid !== live.workerPid)) status = 'interrupted';
    if (status === 'closed' && job) status = 'stopping';
    if (expired(r, now()) && status !== 'closed' && status !== 'cleanup_failed') status = 'expired';
    if (await exists(path.join(r.directory, 'stop-request.json')) && status === 'running') status = 'stopping';
    return { ...r, ...live, id: r.id, port: r.port, directory: r.directory, createdAt: r.createdAt, expiresAt: r.expiresAt, status, jobLoaded: Boolean(job), jobRunning: Boolean(job?.running) };
  }
  async function withServiceResourceLock(id, callback, shared = false) {
    const r = await manifest(id);
    const resourceDirectory = shared ? path.join(stateRoot, '.shared-route-coordination') : path.join(r.directory, 'resource-coordination');
    await fs.mkdir(resourceDirectory, { recursive: true, mode: 0o700 });
    return locked(resourceDirectory, callback);
  }
  async function registerCleanup(id, argv) {
    ensure(Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === 'string' && !a.includes('\0')), 'Cleanup requires an argv string array');
    const current = await readService(id);
    ensure(current.status === 'running', 'Cannot register cleanup on an inactive service; immediately reclaim the newly created resource');
    const command = [await executable(argv[0], current.cwd), ...argv.slice(1)];
    return locked(current.directory, async () => {
      const live = await runtime(current);
      ensure(live.status === 'running' && !expired(current, now()) && !await exists(path.join(current.directory, 'stop-request.json')), 'Service stopped or expired during registration; reclaim the resource immediately');
      const file = path.join(current.directory, 'cleanup.json');
      const entries = await exists(file) ? await readJSON(file) : [];
      const match = entries.find(e => JSON.stringify(e.argv) === JSON.stringify(command));
      if (match) return match;
      const entry = { id: crypto.randomUUID(), argv: command, status: 'pending', registeredAt: new Date(now()).toISOString() };
      entries.push(entry); await atomicJSON(file, entries); return entry;
    });
  }
  async function finish(id) {
    const r = await manifest(id);
    await locked(r.directory, () => writeRuntime(r, { status: 'stopping', workerPid: process.pid }));
    const file = path.join(r.directory, 'cleanup.json');
    const entries = await exists(file) ? await readJSON(file) : [];
    for (const entry of entries) {
      if (entry.status === 'done') continue;
      const result = await backend.execute(entry.argv, r.cwd, { ON_MOBILE_STATE_ROOT: stateRoot, ON_MOBILE_AGENTS_ROOT: agentsRoot, ON_MOBILE_SERVICE_ID: r.id });
      entry.attemptedAt = new Date(now()).toISOString(); entry.status = result.code === 0 ? 'done' : 'failed'; entry.error = result.error || null;
      await atomicJSON(file, entries);
    }
    if (entries.some(e => e.status !== 'done')) { await writeRuntime(r, { status: 'cleanup_failed', workerPid: process.pid, error: 'Scoped resource cleanup failed; retry stop; evidence retained' }); return false; }
    try {
      if (await exists(r.plistPath)) {
        ensure(await fs.readFile(r.plistPath, 'utf8') === plist(r, stateRoot, agentsRoot), 'LaunchAgent file changed; refusing removal');
        await fs.unlink(r.plistPath);
      }
      // Closed is observable only after launchd confirms this job is gone.
      await writeRuntime(r, { status: 'closed', closedAt: new Date(now()).toISOString() });
      await backend.unload(r.label);
      return true;
    } catch (error) {
      await writeRuntime(r, { status: 'cleanup_failed', workerPid: process.pid, error: String(error.message) });
      return false;
    }
  }
  async function start({ cwd, port, argv, inheritFrom }) {
    backend.assertPlatform();
    ensure(path.isAbsolute(cwd || '') && (await fs.stat(cwd)).isDirectory(), '--cwd must be an existing absolute directory');
    ensure(Number.isInteger(port) && port > 0 && port < 65536, '--port must be 1..65535');
    ensure(Array.isArray(argv) && argv.length && argv.every(a => typeof a === 'string' && !a.includes('\0')), 'Command argv required');
    const prior = inheritFrom ? await manifest(inheritFrom) : null;
    ensure(!prior || !expired(prior, now()), 'Original delivery has expired; restoration cannot renew it');
    await backend.portAvailable(port);
    const id = crypto.randomUUID(), directory = directoryFor(id), createdAt = new Date(now()).toISOString();
    const r = { version: 1, id, ownerUid: uid, label: LABEL_PREFIX + id, directory, createdAt, expiresAt: expiresAt(createdAt), cwd: await fs.realpath(cwd), port, argv: [await executable(argv[0], cwd), ...argv.slice(1)], bun: await fs.realpath(process.execPath), script: await fs.realpath(SCRIPT), plistPath: path.join(agentsRoot, LABEL_PREFIX + id + '.plist') };
    if (prior) { r.version = 2; r.inheritFrom = prior.id; r.expiresAt = new Date(Math.min(Date.parse(r.expiresAt), Date.parse(prior.expiresAt))).toISOString(); }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.mkdir(agentsRoot, { recursive: true });
    await atomicJSON(path.join(directory, 'service.json'), r);
    await fs.writeFile(r.plistPath, plist(r, stateRoot, agentsRoot), { flag: 'wx', mode: 0o600 });
    try { await backend.load(r.plistPath, r.label); }
    catch (error) { await writeRuntime(r, { status: 'start_failed', error: String(error.message) }); throw new Error(`Service ${id} failed to bootstrap; state retained: ${error.message}`); }
    return readService(id);
  }
  async function stop(id) {
    const r = await manifest(id);
    await locked(r.directory, () => atomicJSON(path.join(r.directory, 'stop-request.json'), { requestedAt: new Date(now()).toISOString() }));
    if (!await backend.job(r.label)) await finish(id);
    return readService(id);
  }
  async function list() {
    let entries; try { entries = await fs.readdir(stateRoot); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return Promise.all(entries.filter(id => ID.test(id)).map(async id => { try { return await readService(id); } catch (e) { return { id, status: 'invalid', error: e.message }; } }));
  }
  async function worker(id) {
    const r = await manifest(id);
    let child = null, requested = false, lastAttempt = 0, lastRequest = '', childEnded = false;
    const onSignal = () => { requested = true; };
    process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
    try {
      const mustStop = async () => requested || expired(r, now()) || await exists(path.join(r.directory, 'stop-request.json'));
      if (!await mustStop()) {
        try { await backend.portAvailable(r.port); }
        catch (error) {
          await atomicJSON(path.join(r.directory, 'stop-request.json'), { requestedAt: new Date(now()).toISOString(), reason: 'Port unavailable before worker launch: ' + error.message });
        }
      }
      if (!await mustStop()) {
        await writeRuntime(r, { status: 'running', workerPid: process.pid });
        const log = await fs.open(path.join(r.directory, 'server.log'), 'a', 0o600);
        if (!await mustStop()) child = spawnChild(r.argv[0], r.argv.slice(1), { cwd: r.cwd, stdio: ['ignore', log.fd, log.fd], env: { HOME: os.homedir(), TMPDIR: os.tmpdir(), PATH: [path.dirname(r.bun), path.dirname(r.argv[0]), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), ON_MOBILE_SERVICE_ID: r.id, ON_MOBILE_STATE_ROOT: stateRoot, ON_MOBILE_AGENTS_ROOT: agentsRoot } });
        child?.once('exit', () => { childEnded = true; });
        child?.once('error', () => { childEnded = true; });
        await log.close();
        if (child) await writeRuntime(r, { status: 'running', workerPid: process.pid, childPid: child.pid });
      }
      while (true) {
        if (await mustStop()) {
          // Persist signals too: a worker killed during failed cleanup must never
          // restart its server merely because its original TTL has not elapsed.
          const stopFile = path.join(r.directory, 'stop-request.json');
          await locked(r.directory, async () => {
            if (!await exists(stopFile)) await atomicJSON(stopFile, { requestedAt: new Date(now()).toISOString(), reason: requested ? 'Worker termination requested' : 'Service expired' });
          });
          if (child && !childEnded) {
            child.kill('SIGTERM');
            await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
            if (!childEnded) {
              child.kill('SIGKILL');
              await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
            }
            if (!childEnded) {
              await writeRuntime(r, { status: 'cleanup_failed', workerPid: process.pid, error: 'Owned child has not exited; no successful cleanup claimed' });
              throw new Error('Owned child did not exit after scoped termination');
            }
          }
          const request = await exists(stopFile) ? (await readJSON(stopFile)).requestedAt : 'expired';
          if (now() - lastAttempt >= 60000 || request !== lastRequest) {
            lastAttempt = now(); lastRequest = request;
            if (await finish(id)) return;
          }
        } else if (childEnded) {
          await writeRuntime(r, { status: 'interrupted', error: 'Server exited; launchd will retry within the original lifetime' });
          throw new Error('Preview server exited');
        } else {
          await writeRuntime(r, { status: 'running', workerPid: process.pid, childPid: child?.pid, heartbeatAt: new Date(now()).toISOString() });
        }
        await sleep(1000);
      }
    } finally { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
  }
  return { start, stop, list, readService, registerCleanup, withServiceResourceLock, finish, worker, manifest };
}

function defaultManager() { return createManager({ stateRoot: process.env.ON_MOBILE_STATE_ROOT, agentsRoot: process.env.ON_MOBILE_AGENTS_ROOT }); }
export const readService = id => defaultManager().readService(id);
export const registerCleanup = (id, argv) => defaultManager().registerCleanup(id, argv);
export const withServiceResourceLock = (id, callback, shared = false) => defaultManager().withServiceResourceLock(id, callback, shared);

async function cli(args) {
  const command = args.shift();
  if (command === '_worker') {
    const id = args.shift();
    ensure(args.length === 4 && args[0] === '--state-root' && args[2] === '--agents-root', 'Invalid worker arguments');
    return createManager({ stateRoot: args[1], agentsRoot: args[3] }).worker(id);
  }
  const manager = defaultManager();
  if (command === 'start') {
    const delimiter = args.indexOf('--'); ensure(delimiter >= 0, 'Usage: start --cwd ABS --port PORT -- COMMAND ARGS...');
    const flags = args.slice(0, delimiter); ensure([4, 6].includes(flags.length) && flags[0] === '--cwd' && flags[2] === '--port' && (flags.length === 4 || flags[4] === '--inherit'), 'Usage: start --cwd ABS --port PORT [--inherit ORIGINAL_ID] -- COMMAND ARGS...');
    return manager.start({ cwd: flags[1], port: Number(flags[3]), inheritFrom: flags[5], argv: args.slice(delimiter + 1) });
  }
  if (command === 'list') { ensure(!args.length, 'list takes no arguments'); return manager.list(); }
  ensure(args.length === 1 && ['status', 'stop'].includes(command), 'Usage: status ID | stop ID | list');
  return command === 'stop' ? manager.stop(args[0]) : manager.readService(args[0]);
}
if (import.meta.main) {
  try { const result = await cli(process.argv.slice(2)); if (result !== undefined) console.log(JSON.stringify(result, null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
