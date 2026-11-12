import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseInventory, recordCheck, checkedAccount, validateBinding } from '../scripts/lib/ngrok-accounts.mjs';
import { switchNgrokAccount } from '../scripts/mobile-url-for-port.mjs';
let dir, account, inventory, checks;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'account-check-')));
  account = { id: 'fixture', name: 'Fixture', email: 'test@example.invalid', configPath: path.join(dir, 'agent.yml'), domain: 'https://fixture.example.invalid', history: 'Past observation only' };
  await fs.writeFile(account.configPath, 'version: 3\n', { mode: 0o600 });
  inventory = path.join(dir, '.env'); checks = path.join(dir, 'checks.json');
  await fs.writeFile(inventory, `ON_MOBILE_NGROK_ACCOUNTS='${JSON.stringify([account])}'\n`, { mode: 0o600 });
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true }));
test('inventory accepts literal paths without shell evaluation and rejects credential keys or duplicate configs', () => {
  const parse = a => parseInventory(`ON_MOBILE_NGROK_ACCOUNTS='${JSON.stringify(a)}'`);
  expect(parse([account])[0].email).toBe(account.email);
  expect(() => parse([{ ...account, authtoken: 'not-a-credential' }])).toThrow('only');
  expect(() => parse([account, { ...account, id: 'second' }])).toThrow('distinct');
  expect(() => parse([{ ...account, configPath: '/tmp/one,/tmp/two' }])).toThrow();
  expect(() => parseInventory('export ON_MOBILE_NGROK_ACCOUNTS=$(anything)')).toThrow();
});
test('unknown, stale, exhausted and config-changed checks cannot start a new tunnel', async () => {
  const select = extra => checkedAccount('fixture', { inventory, checks, ...extra });
  await expect(select()).rejects.toThrow('dashboard check');
  await expect(recordCheck(account, { identity: 'wrong', quota: 'available', source: 'dashboard' }, checks)).rejects.toThrow('identity');
  for (const quota of ['unknown', 'exhausted']) {
    await recordCheck(account, { identity: account.email, quota, source: 'dashboard' }, checks);
    await expect(select()).rejects.toThrow('dashboard check');
  }
  await recordCheck(account, { identity: account.email, quota: 'available', source: 'dashboard' }, checks);
  const binding = await select(); expect(binding.accountId).toBe('fixture');
  await expect(select({ now: Date.now() + 31 * 60000 })).rejects.toThrow('dashboard check');
  await fs.appendFile(account.configPath, '# changed\n');
  await expect(select()).rejects.toThrow('dashboard check');
  await expect(validateBinding(binding)).rejects.toThrow('changed');
});
test('insecure config permissions and symlinks fail before credential reads', async () => {
  const check = () => recordCheck(account, { identity: account.email, quota: 'available', source: 'dashboard' }, checks);
  await fs.chmod(account.configPath, 0o644); await expect(check()).rejects.toThrow('0600');
  await fs.rename(account.configPath, `${account.configPath}.real`); await fs.symlink(`${account.configPath}.real`, account.configPath);
  await expect(check()).rejects.toThrow('0600');
});
function transaction() {
  const calls = [], service = { id: 'origin', expiresAt: '2030-01-01T00:00:00.000Z' };
  const old = { kind: 'ngrok', agentId: 'old-agent', accountId: 'old', baseUrl: 'https://old.example.invalid' };
  const ops = { check: async () => { calls.push('check'); return { accountId: 'new' }; }, route: async () => old,
    verify: async () => { calls.push('verify'); }, audit: async a => { calls.push(a.phase); }, cleanup: async () => { calls.push('cleanup-old-agent'); },
    create: async () => { calls.push('create'); return { route: { baseUrl: 'https://new.example.invalid' }, agent: { expiresAt: service.expiresAt } }; } };
  return { calls, service, old, ops, options: { switchNgrokFrom: 'old', ngrokAccount: 'new' } };
}
test('explicit switch verifies before scoped cleanup, reports changed URL and keeps original expiry', async () => {
  const t = transaction(); const result = await switchNgrokAccount(t.service, t.options, t.ops);
  expect(t.calls).toEqual(['check', 'verify', 'switching', 'cleanup-old-agent', 'create', 'ready']);
  expect(result.switch.urlChanged).toBe(true); expect(result.switch.expiresAt).toBe(t.service.expiresAt);
});
test('missing authorization, wrong source or quota/ownership failures never stop any agent', async () => {
  for (const kind of ['missing', 'wrong', 'quota', 'ownership']) {
    const t = transaction();
    if (kind === 'missing') t.options.switchNgrokFrom = '';
    if (kind === 'wrong') t.old.accountId = 'unrelated';
    if (kind === 'quota') t.ops.check = async () => { throw new Error('quota unavailable'); };
    if (kind === 'ownership') t.ops.verify = async () => { throw new Error('foreign listener'); };
    await expect(switchNgrokAccount(t.service, t.options, t.ops)).rejects.toThrow();
    expect(t.calls).not.toContain('cleanup-old-agent'); expect(t.calls).not.toContain('create');
  }
});
test('failed replacement retains failure evidence without rotating or restarting other accounts', async () => {
  const t = transaction(); t.ops.create = async () => { throw new Error('provider unavailable'); };
  await expect(switchNgrokAccount(t.service, t.options, t.ops)).rejects.toThrow('provider unavailable');
  expect(t.calls).toEqual(['check', 'verify', 'switching', 'cleanup-old-agent', 'failed']);
});
test('managed origin restart resumes the switched binding after check expiry, without switching back to its old argv account', async () => {
  const { resolveAccountForRoute } = await import('../scripts/lib/ngrok-accounts.mjs');
  await recordCheck(account, { identity: account.email, quota: 'available', source: 'dashboard' }, checks);
  const binding = await checkedAccount('fixture', { inventory, checks });
  const saved = { accountId: 'fixture', agentId: 'owned-agent' };
  const deps = { check: () => { throw new Error('stale check'); }, binding: async () => binding };
  expect((await resolveAccountForRoute({ saved, requestedId: 'old-account', managedResume: true }, deps)).accountId).toBe('fixture');
  await expect(resolveAccountForRoute({ saved, requestedId: 'old-account', managedResume: false }, deps)).rejects.toThrow('explicitly');
  await expect(resolveAccountForRoute({ saved, requestedId: 'fixture', managedResume: false }, deps)).rejects.toThrow('stale check');
  await fs.appendFile(account.configPath, '# changed\n');
  await expect(resolveAccountForRoute({ saved, requestedId: 'old-account', managedResume: true }, deps)).rejects.toThrow('changed');
});
test('configured domain origin is canonical before pinning', async () => {
  account.domain += '/';
  await fs.writeFile(inventory, `ON_MOBILE_NGROK_ACCOUNTS='${JSON.stringify([account])}'`);
  await recordCheck(account, { identity: account.email, quota: 'available', source: 'dashboard' }, checks);
  expect((await checkedAccount('fixture', { inventory, checks })).domain).toBe('https://fixture.example.invalid');
});
