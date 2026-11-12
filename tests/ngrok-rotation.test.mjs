import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { recordCheck, readChecks, checkedAccount, rotationCandidates, quotaStatus, migrateChecks, updatePrivateJSON, withRotationLock, authorizeRotationService } from '../scripts/lib/ngrok-accounts.mjs';
import { classifyNgrokError, probeNgrok, rotateNgrok } from '../scripts/lib/ngrok-rotation.mjs';
let dir, inventory, checks, policy, accounts;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ngrok-rotation-')));
  inventory = path.join(dir, '.env'); checks = path.join(dir, 'checks.json'); policy = path.join(dir, 'policy.json');
  accounts = ['first','second','third'].map(id => ({ id, name: 'Fixture', email: `${id}@example.invalid`, configPath: path.join(dir, `${id}.yml`), domain: `https://${id}.example.invalid`, history: 'unknown' }));
  for (const a of accounts) await fs.writeFile(a.configPath, 'version: 3\n', { mode: 0o600 });
  await fs.writeFile(inventory, `ON_MOBILE_NGROK_ACCOUNTS='${JSON.stringify(accounts)}'`, { mode: 0o600 });
  await updatePrivateJSON(policy, () => ({ enabled: true, accounts: accounts.map(a => a.id) }));
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true }));
const observe = (a, quota, extra = {}) => recordCheck(a, { identity: a.email, quota, source: 'dashboard', ...extra }, checks);
test('pool priority skips unknown, exhausted, stale and changed-config accounts', async () => {
  await observe(accounts[0], 'exhausted'); await observe(accounts[2], 'available');
  expect((await rotationCandidates({ inventory, checks, policy })).candidates.map(a => a.accountId)).toEqual(['third']);
  await observe(accounts[1], 'available');
  expect((await rotationCandidates({ inventory, checks, policy })).candidates.map(a => a.accountId)).toEqual(['second','third']);
  await fs.appendFile(accounts[1].configPath, '# changed');
  expect((await rotationCandidates({ inventory, checks, policy })).candidates.map(a => a.accountId)).toEqual(['third']);
  expect((await rotationCandidates({ inventory, checks, policy, now: Date.now() + 31 * 60000 })).candidates).toEqual([]);
  await updatePrivateJSON(policy, p => ({ ...p, enabled: false }));
  await expect(rotationCandidates({ inventory, checks, policy })).rejects.toThrow('off');
});
test('reset becomes unknown until evidence confirms recovery; actual observation and recording time remain distinct', async () => {
  const prior = new Date(Date.now() - 10000).toISOString(), reset = new Date(Date.now() - 5000).toISOString();
  const exhausted = await observe(accounts[0], 'exhausted', { checkedAt: prior, providerResetAt: reset, usedBytes: 100, limitBytes: 100 });
  expect(exhausted.recordedAt > exhausted.checkedAt).toBe(true);
  expect(quotaStatus(exhausted).reason).toBe('reset-due-recheck');
  expect(quotaStatus(exhausted).quota).toBe('unknown');
  await expect(checkedAccount('first', { inventory, checks })).rejects.toThrow('dashboard');
  const restored = await observe(accounts[0], 'available', { usedBytes: 0, limitBytes: 100 });
  expect(restored.restoredAt).toBe(restored.checkedAt);
  expect(restored.history[0].quota).toBe('exhausted');
  expect((await checkedAccount('first', { inventory, checks })).accountId).toBe('first');
  await expect(observe(accounts[0], 'unknown', { checkedAt: prior })).rejects.toThrow('Older evidence');
});
test('only dashboard establishes available; numerical contradiction and guessed API sources are rejected', async () => {
  await expect(observe(accounts[0], 'available', { source: 'user-report' })).rejects.toThrow('dashboard');
  await expect(observe(accounts[0], 'available', { source: 'official-api' })).rejects.toThrow('adapter');
  await expect(observe(accounts[0], 'available', { usedBytes: 100, limitBytes: 100 })).rejects.toThrow('contradicts');
  await expect(observe(accounts[0], 'exhausted', { source: 'provider-error', errorCode: 'ERR_NGROK_4013' })).rejects.toThrow('725');
  const row = await observe(accounts[0], 'exhausted', { source: 'provider-error', errorCode: 'ERR_NGROK_725' });
  expect(row.errorCode).toBe('ERR_NGROK_725');
  expect(row.estimatedResetDate.endsWith('-01')).toBe(true);
  expect(row.providerResetAt).toBeNull();
});
test('concurrent quota writers preserve every account and history', async () => {
  await Promise.all(accounts.map(a => observe(a, 'unknown')));
  expect(Object.keys(await readChecks(checks))).toHaveLength(3);
  await Promise.all(accounts.map(a => observe(a, 'available')));
  expect(Object.values(await readChecks(checks)).every(a => a.history.length === 1)).toBe(true);
  expect((await fs.stat(checks)).mode & 0o777).toBe(0o600);
});
test('global rotation lock serializes distinct processes and releases after SIGKILL', async () => {
  const module = path.resolve(import.meta.dir, '../scripts/lib/ngrok-accounts.mjs');
  const marker = path.join(dir, 'locked');
  const child = spawn(process.execPath, ['-e', `import {withRotationLock} from ${JSON.stringify(module)}; await withRotationLock(async()=>{await Bun.write(${JSON.stringify(marker)}, 'ready'); await new Promise(()=>{});}, ${JSON.stringify(dir)});`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !(await fs.exists(marker)); i++) await Bun.sleep(10);
    expect(await fs.exists(marker)).toBe(true);
    let entered = false;
    const second = withRotationLock(async () => { entered = true; }, dir);
    await Bun.sleep(80); expect(entered).toBe(false);
    child.kill('SIGKILL'); await second; expect(entered).toBe(true);
  } finally { child.kill('SIGKILL'); }
});
test('only 725 exhausts; success is HEAD-only and other errors never rotate', async () => {
  expect(classifyNgrokError('ERR_NGROK_725')).toBe('exhausted');
  expect(classifyNgrokError('ERR_NGROK_4013')).toBe('provider-blocked');
  expect(classifyNgrokError('403')).toBe('unknown');
  const calls = [];
  const good = await probeNgrok('https://fixture.invalid', 1000, async (_, options) => { calls.push(options.method); return new Response(null, { status: 200 }); });
  expect(good.ok).toBe(true); expect(calls).toEqual(['HEAD']);
  const quota = await probeNgrok('https://fixture.invalid', 1000, async () => new Response(null, { status: 403, headers: { 'ngrok-error-code': 'ERR_NGROK_725' } }));
  expect(quota.classification).toBe('exhausted'); expect(quota.ok).toBe(false);
  const denied = await probeNgrok('https://fixture.invalid', 1000, async () => new Response('ordinary access denied', { status: 403 }));
  expect(denied.classification).toBe('unknown'); expect(denied.ok).toBe(false);
});
function scenario() {
  const service = { id: 'origin', expiresAt: '2030-01-01T00:00:00.000Z' };
  const old = { kind: 'ngrok', accountId: 'first', agentId: 'old-agent', baseUrl: 'https://first.example.invalid' };
  let route = old; const calls = [], audits = [];
  const exhausted = { ok: false, classification: 'exhausted', errorCode: 'ERR_NGROK_725' };
  const ops = {
    route: async () => route, verify: async r => { calls.push(`verify:${r.accountId}`); }, active: async () => {},
    check: async () => {}, candidates: async () => ({ candidates: [{ accountId: 'second' }, { accountId: 'third' }], skipped: [] }),
    reuse: async r => ({ route: r, agent: { expiresAt: service.expiresAt } }),
    probe: async r => r.accountId === 'first' ? exhausted : { ok: true },
    observed: async (id, p) => { calls.push(`observed:${id}:${p.ok}`); },
    audit: async value => { audits.push(structuredClone(value)); },
    cleanup: async () => { calls.push(`cleanup:${route.accountId}`); route = { ...route, removed: true }; },
    create: async id => { calls.push(`create:${id}`); route = { ...old, accountId: id, agentId: `${id}-agent`, baseUrl: `https://${id}.example.invalid` }; return { route, agent: { id: route.agentId, expiresAt: service.expiresAt } }; },
  };
  return { service, old, ops, calls, audits, exhausted };
}
test('automatic switch preserves exact deadline and reports actual old/new domains', async () => {
  const t = scenario(), result = await rotateNgrok(t.service, {}, t.ops);
  expect(result.rotation.oldUrl).toBe(t.old.baseUrl); expect(result.rotation.newUrl).toBe('https://second.example.invalid');
  expect(result.rotation.urlChanged).toBe(true); expect(result.agent.expiresAt).toBe(t.service.expiresAt);
  expect(t.calls.filter(x => x.startsWith('cleanup:'))).toEqual(['cleanup:first']);
});
test('healthy existing URL is reused; no candidate or wrong ownership never stops old agent', async () => {
  for (const failure of ['healthy','empty','ownership','blocked']) {
    const t = scenario();
    if (failure === 'healthy') t.ops.probe = async () => ({ ok: true });
    if (failure === 'empty') t.ops.candidates = async () => ({ candidates: [], skipped: [] });
    if (failure === 'ownership') t.ops.verify = async () => { throw new Error('foreign agent'); };
    if (failure === 'blocked') t.ops.probe = async () => ({ ok: false, classification: 'provider-blocked' });
    if (failure === 'healthy') expect((await rotateNgrok(t.service, {}, t.ops)).route).toEqual(t.old);
    else await expect(rotateNgrok(t.service, {}, t.ops)).rejects.toThrow();
    expect(t.calls.some(x => x.startsWith('cleanup:'))).toBe(false);
  }
});
test('each candidate tried once; non-quota failure stops with retained recovery evidence', async () => {
  const t = scenario(); t.ops.probe = async () => t.exhausted;
  await expect(rotateNgrok(t.service, {}, t.ops)).rejects.toThrow('candidates exhausted');
  expect(t.calls.filter(x => x.startsWith('create:'))).toEqual(['create:second','create:third']);
  expect(t.audits.at(-1).oldRoute).toEqual(t.old); expect(t.audits.at(-1).restored).toBe(false);
  const other = scenario(); other.ops.create = async () => { throw new Error('provider unavailable'); };
  await expect(rotateNgrok(other.service, {}, other.ops)).rejects.toThrow('provider unavailable');
  expect(other.audits.at(-1).phase).toBe('failed'); expect(other.audits.at(-1).expiresAt).toBe(other.service.expiresAt);
  expect(other.calls).not.toContain('create:third');
});
test('legacy migration never refreshes timestamps or replaces newer checks', async () => {
  const legacy = path.join(dir, 'legacy.json');
  await fs.writeFile(legacy, JSON.stringify({ first: { quota: 'available', checkedAt: '2020-01-01T00:00:00Z' } }), { mode: 0o600 });
  await migrateChecks(legacy, checks);
  expect(quotaStatus((await readChecks(checks)).first).quota).toBe('unknown');
  await observe(accounts[0], 'exhausted'); const before = await fs.readFile(checks, 'utf8');
  await migrateChecks(legacy, checks); expect(await fs.readFile(checks, 'utf8')).toBe(before);
  expect(await fs.exists(legacy)).toBe(true);
});
test('whole skill replacement and CODEX_HOME change preserve observations, rotation grants and inventory', async () => {
  const home = path.join(dir, 'home'), external = path.join(home, '.config/on-mobile'), skill = path.join(home, 'skill');
  await fs.mkdir(external, { recursive: true, mode: 0o700 });
  await observe(accounts[0], 'exhausted');
  for (const [from, to] of [[checks,'ngrok-checks.json'],[policy,'ngrok-rotation.json'],[inventory,'.env']]) await fs.copyFile(from, path.join(external,to));
  const read = () => JSON.parse(execFileSync(process.execPath, ['-e', 'const m = await import("./scripts/lib/ngrok-accounts.mjs"); console.log(JSON.stringify({checks:await m.readChecks(),policy:await m.readChecks(m.policyFile),accounts:await m.readInventory()}))'], { cwd: skill, encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: path.join(home,'elsewhere') } }));
  await fs.cp(path.resolve(import.meta.dir,'../scripts'), path.join(skill,'scripts'), { recursive: true }); const before = read();
  await fs.rm(skill, { recursive: true }); await fs.cp(path.resolve(import.meta.dir,'../scripts'), path.join(skill,'scripts'), { recursive: true });
  expect(read()).toEqual(before); expect(read().checks.first.quota).toBe('exhausted');
});
test('application error-code examples never trigger exhaustion or body downloads', async () => {
  let calls = 0;
  const probe = await probeNgrok('https://fixture.invalid', 1000, async () => { calls++; return new Response('Help: ERR_NGROK_725 means quota', { status: 404, headers: { 'content-type': 'text/plain' } }); });
  expect(probe.classification).toBe('unknown'); expect(calls).toBe(1);
});
test('rechecks preserve first recovery time; new exhaustion opens a new recovery cycle', async () => {
  await observe(accounts[0], 'exhausted'); const recovered = await observe(accounts[0], 'available');
  await Bun.sleep(5); const again = await observe(accounts[0], 'available');
  expect(again.restoredAt).toBe(recovered.restoredAt);
  await observe(accounts[0], 'unknown'); const afterUnknown = await observe(accounts[0], 'available');
  expect(afterUnknown.restoredAt).toBe(recovered.restoredAt);
  await observe(accounts[0], 'exhausted'); await Bun.sleep(5);
  expect((await observe(accounts[0], 'available')).restoredAt > recovered.restoredAt).toBe(true);
});
test('725 retains still-future provider reset evidence without relabeling it as a fresh query', async () => {
  const reset = new Date(Date.now() + 86400000).toISOString();
  const prior = await observe(accounts[0], 'available', { providerResetAt: reset });
  const exhausted = await observe(accounts[0], 'exhausted', { source: 'provider-error', errorCode: 'ERR_NGROK_725' });
  expect(exhausted.providerResetAt).toBe(reset); expect(exhausted.cycleEvidenceAt).toBe(prior.checkedAt); expect(exhausted.cycleEvidenceSource).toBe('dashboard');
  expect(quotaStatus(exhausted, Date.parse(reset) + 1).reason).toBe('reset-due-recheck');
});

test('restored origins can be authorized without admitting foreign chats or ngrok agents', async () => {
  const origin = { id: 'restored-origin', inheritFrom: 'original', ownerThreadId: 'this-chat', status: 'running', expiresAt: new Date(Date.now() + 60000).toISOString(), argv: ['/bun','/fixture/server.mjs'] };
  await authorizeRotationService(origin, 'this-chat', policy);
  expect((await readChecks(policy)).services[origin.id].expiresAt).toBe(origin.expiresAt);
  await expect(authorizeRotationService(origin, 'another-chat', policy)).rejects.toThrow('another chat');
  await expect(authorizeRotationService({ ...origin, argv: ['/bun','/fixture/mobile-ngrok.mjs'] }, 'this-chat', policy)).rejects.toThrow('running origin');
});
