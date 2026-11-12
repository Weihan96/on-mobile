/** Private account inventory; configuration files remain the only credential store. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { constants } from 'node:fs';
const withDirectoryLock = async (...args) => (await import('../mobile-service.mjs')).withDirectoryLock(...args);
// Keep account resources independent of replaceable skill trees and CODEX_HOME.
export const inventoryFile = path.join(os.homedir(), '.config/on-mobile/.env');
export const stateDirectory = path.join(os.homedir(), '.config/on-mobile');
export const checksFile = path.join(stateDirectory, 'ngrok-checks.json');
export const policyFile = path.join(stateDirectory, 'ngrok-rotation.json');
const ensure = (v, m) => { if (!v) throw new Error(m); };
const keys = ['id', 'name', 'email', 'configPath', 'domain', 'history'];
export function parseInventory(text) {
  // Deliberately do not source/evaluate a shell file or interpolate environment variables.
  const lines = text.split(/\r?\n/).filter(s => s.trim() && !s.trim().startsWith('#'));
  ensure(lines.length === 1 && lines[0].startsWith('ON_MOBILE_NGROK_ACCOUNTS='), 'Expected one ON_MOBILE_NGROK_ACCOUNTS JSON assignment in local .env');
  let value = lines[0].slice('ON_MOBILE_NGROK_ACCOUNTS='.length).trim();
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  let accounts; try { accounts = JSON.parse(value); } catch { throw new Error('Invalid account inventory JSON'); }
  ensure(Array.isArray(accounts) && accounts.length > 0, 'Account inventory is empty');
  const ids = new Set(), configs = new Set();
  for (const a of accounts) {
    ensure(a && Object.keys(a).every(k => keys.includes(k)) && keys.every(k => typeof a[k] === 'string'), 'Account inventory must contain only id, name, email, configPath, domain and history; never credentials');
    ensure(/^[a-z][a-z0-9-]{0,63}$/.test(a.id) && !ids.has(a.id), 'Invalid or duplicate account ID'); ids.add(a.id);
    ensure(path.isAbsolute(a.configPath) && !a.configPath.includes(',') && !configs.has(a.configPath), 'Each account requires a distinct absolute config path without commas'); configs.add(a.configPath);
    ensure(a.name && a.email, 'Account identity is required');
    if (a.domain) { let u; try { u = new URL(a.domain); } catch {} ensure(u?.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash, 'Account domain must be an HTTPS origin'); }
  }
  return accounts;
}
async function privateInventoryBytes(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    ensure(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'Account inventory must be an owned private regular file (0600), not a link');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function readInventory(file = inventoryFile) {
  try { return parseInventory((await privateInventoryBytes(file)).toString('utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('No account inventory at ~/.config/on-mobile/.env; migrate the old .env with mobile-ngrok-accounts.mjs migrate --from ABS_OLD_ENV'); throw e; }
}
export async function migrateInventory(source, destination = inventoryFile) {
  ensure(path.isAbsolute(source) && path.isAbsolute(destination), 'Migration requires absolute file paths');
  const bytes = await privateInventoryBytes(source);
  const accounts = parseInventory(bytes.toString('utf8'));
  // Reject existing directory links before creating anything in the fixed location.
  for (let p = path.dirname(destination); ; p = path.dirname(p)) {
    try { const stat = await fs.lstat(p); ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'Account config directory must not traverse links'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const existing = async () => {
    ensure(bytes.equals(await privateInventoryBytes(destination)), 'External account inventory differs; retained both files without overwriting. Review explicitly before combining.');
    return { destination, accountCount: accounts.length, status: 'already-present', sourceRetained: true };
  };
  const temp = path.join(path.dirname(destination), `.migration-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Atomic no-clobber publication: a concurrent migration cannot replace a file.
    try { await fs.link(temp, destination); }
    catch (e) { if (e.code === 'EEXIST') return await existing(); throw e; }
    ensure(bytes.equals(await privateInventoryBytes(destination)), 'Migration verification failed; source retained');
    return { destination, accountCount: accounts.length, status: 'migrated', sourceRetained: true };
  } finally { await fs.rm(temp, { force: true }); }
}
export async function configFingerprint(file) {
  const stat = await fs.lstat(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid(), 'ngrok config must be an owned regular file with private permissions (0600)');
  // Hash in memory; never print, copy, parse or persist the credential contents.
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
export async function readChecks(file = checksFile) {
  try { return JSON.parse((await privateInventoryBytes(file)).toString('utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export async function privateDirectory(directory) {
  for (let p = directory; ; p = path.dirname(p)) {
    try { const stat = await fs.lstat(p); ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'State directory must not traverse links'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}
export async function updatePrivateJSON(file, update) {
  await privateDirectory(path.dirname(file));
  return withDirectoryLock(path.dirname(file), async () => {
    const current = await readChecks(file), next = await update(current);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }); }
    return next;
  });
}
export const FRESH_MS = 30 * 60 * 1000;
export function quotaStatus(check, now = Date.now()) {
  if (!check) return { quota: 'unknown', reason: 'needs-dashboard-check' };
  const age = now - Date.parse(check.checkedAt);
  const reset = check.providerResetAt || check.estimatedResetAt || check.estimatedResetDate || check.cycleEnd;
  const resetDue = !!reset && now >= Date.parse(reset) && Date.parse(check.checkedAt) < Date.parse(reset);
  const stale = !(age >= 0 && age <= FRESH_MS);
  return { quota: resetDue || stale ? 'unknown' : check.quota, reason: resetDue ? 'reset-due-recheck' : stale ? 'stale-recheck' : 'observed', resetDue, stale };
}
const timestamp = value => value == null || (typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
export async function recordCheck(account, input, file = checksFile) {
  const { identity, quota, source } = input;
  ensure(identity === account.email, 'Checked identity must exactly match this account email');
  ensure(['available', 'exhausted', 'unknown'].includes(quota), 'Invalid quota');
  ensure(['dashboard', 'provider-error', 'user-report'].includes(source), 'Unsupported evidence source; no verified quota API adapter exists');
  ensure(source === 'dashboard' || quota !== 'available', 'Only verified dashboard evidence can establish available quota');
  ensure(!input.providerResetAt || source === 'dashboard', 'Provider reset time requires dashboard evidence');
  ensure(source !== 'provider-error' || (input.errorCode === 'ERR_NGROK_725' && quota === 'exhausted'), 'Only ERR_NGROK_725 proves bandwidth exhaustion');
  for (const key of ['checkedAt', 'cycleStart', 'cycleEnd', 'providerResetAt', 'estimatedResetAt']) ensure(timestamp(input[key]), `Invalid ${key}: use an ISO timestamp with timezone`);
  const checkedAt = input.checkedAt || new Date().toISOString();
  ensure(Date.parse(checkedAt) <= Date.now(), 'Future observations are not evidence');
  for (const key of ['usedBytes', 'limitBytes']) ensure(input[key] == null || (Number.isSafeInteger(input[key]) && input[key] >= 0), `Invalid ${key}`);
  ensure(!(quota === 'available' && input.limitBytes != null && input.usedBytes >= input.limitBytes), 'Usage contradicts available quota');
  if (input.cycleStart && input.cycleEnd) ensure(Date.parse(input.cycleStart) < Date.parse(input.cycleEnd), 'Invalid billing cycle');
  const configHash = await configFingerprint(account.configPath);
  let result;
  await updatePrivateJSON(file, checks => {
    const prior = checks[account.id];
    ensure(!prior?.checkedAt || Date.parse(checkedAt) >= Date.parse(prior.checkedAt), 'Older evidence cannot replace a newer observation');
    const carryCycle = prior?.configHash === configHash && prior?.identity === identity && Date.parse(prior.providerResetAt || prior.cycleEnd || prior.estimatedResetAt) > Date.parse(checkedAt) && !input.cycleStart && !input.cycleEnd;
    const cycleFields = ['cycleStart', 'cycleEnd', 'providerResetAt', 'estimatedResetAt'];
    const cycle = Object.fromEntries(cycleFields.map(key => [key, input[key] ?? (carryCycle ? prior[key] ?? null : null)]));
    const hasCycleEvidence = cycleFields.some(key => input[key] != null);
    const previousDefinite = [prior, ...(prior?.history || []).toReversed()].find(row => row && row.quota !== 'unknown');
    result = { identity, quota, source, checkedAt, recordedAt: new Date().toISOString(), configHash,
      lastVerifiedAt: ['dashboard', 'provider-error'].includes(source) ? checkedAt : (prior?.lastVerifiedAt || (prior?.source === 'dashboard' ? prior.checkedAt : null)),
      usedBytes: input.usedBytes ?? null, limitBytes: input.limitBytes ?? null,
      ...cycle, cycleEvidenceAt: hasCycleEvidence ? checkedAt : carryCycle ? prior.cycleEvidenceAt || prior.checkedAt : null,
      cycleEvidenceSource: hasCycleEvidence ? source : carryCycle ? prior.cycleEvidenceSource || prior.source : null,
      estimatedResetDate: new Date(Date.UTC(new Date(checkedAt).getUTCFullYear(), new Date(checkedAt).getUTCMonth() + 1, 1)).toISOString().slice(0, 10),
      estimateBasis: 'Calendar month first day per pricing docs; exact account reset time/timezone unverified',
      errorCode: quota === 'exhausted' && input.errorCode === 'ERR_NGROK_725' ? input.errorCode : null,
      restoredAt: quota === 'available' && previousDefinite?.quota === 'exhausted' ? checkedAt : prior?.restoredAt || null,
      history: prior ? [...(prior.history || []), Object.fromEntries(Object.entries(prior).filter(([k]) => k !== 'history'))] : [] };
    return { ...checks, [account.id]: result };
  });
  return result;
}
export async function migrateChecks(source, destination = checksFile) {
  const legacy = await readChecks(source);
  ensure(Object.keys(legacy).length, 'No legacy observations to migrate');
  await updatePrivateJSON(destination, current => {
    for (const [id, check] of Object.entries(legacy)) {
      ensure(/^[a-z][a-z0-9-]{0,63}$/.test(id) && ['available','exhausted','unknown'].includes(check.quota) && timestamp(check.checkedAt), 'Invalid legacy observation');
      // Retain original time; never refresh or overwrite newer evidence during install.
      if (!current[id]) current[id] = { ...check, migratedAt: new Date().toISOString() };
    }
    return current;
  });
  return { destination, sourceRetained: true, status: 'merged-missing-only' };
}
export async function checkedAccount(id, { inventory = inventoryFile, checks = checksFile, now = Date.now() } = {}) {
  const account = (await readInventory(inventory)).find(a => a.id === id);
  ensure(account, 'Choose an account ID from mobile-ngrok-accounts.mjs list');
  const checked = (await readChecks(checks))[id], configHash = await configFingerprint(account.configPath);
  ensure(checked?.identity === account.email && checked.source === 'dashboard' && quotaStatus(checked, now).quota === 'available' && checked.configHash === configHash, 'Account identity and available quota require a dashboard check within 30 minutes for this exact config; historical usage is not current quota');
  return { accountId: id, configPath: account.configPath, configHash, domain: account.domain ? new URL(account.domain).origin : "" };
}
export async function authorizeRotationService(service, threadId, file = policyFile) {
  ensure(threadId && !service.argv?.[1]?.endsWith('/mobile-ngrok.mjs') && service.status === 'running' && Date.now() < Date.parse(service.expiresAt), 'Authorization requires a running origin and current CODEX_THREAD_ID');
  ensure(!service.ownerThreadId || service.ownerThreadId === threadId, 'Origin belongs to another chat');
  return updatePrivateJSON(file, current => {
    const previous = current.services?.[service.id];
    ensure(!previous || previous.threadId === threadId, 'Service is already authorized by another chat');
    return { ...current, services: { ...current.services, [service.id]: { threadId, expiresAt: service.expiresAt, authorizedAt: new Date().toISOString() } } };
  });
}
export async function rotationCandidates({ policy = policyFile, inventory = inventoryFile, checks = checksFile, exclude = [], now = Date.now() } = {}) {
  const settings = await readChecks(policy);
  ensure(settings.enabled === true && Array.isArray(settings.accounts), 'Automatic rotation is off; authorize a pool first');
  const candidates = [], skipped = [];
  for (const id of settings.accounts) {
    if (exclude.includes(id)) continue;
    try { candidates.push(await checkedAccount(id, { inventory, checks, now })); }
    catch { skipped.push({ accountId: id, reason: 'needs-current-identity-and-quota-verification' }); }
  }
  return { candidates, skipped };
}
export async function withRotationLock(operation, directory = stateDirectory) {
  const lock = path.join(directory, 'rotation-lock');
  await privateDirectory(lock);
  return withDirectoryLock(lock, operation);
}
export async function validateBinding(binding) {
  ensure(binding && /^[a-z][a-z0-9-]{0,63}$/.test(binding.accountId) && path.isAbsolute(binding.configPath || '') && !binding.configPath.includes(','), 'Invalid ngrok account binding');
  ensure(binding.configHash === await configFingerprint(binding.configPath), 'ngrok config changed since account verification; do not silently change identity');
  return binding;
}

// A managed Markdown worker resumes its persisted route after restart. This is
// distinct from a user requesting a new delivery or switching an account.
export async function resolveAccountForRoute({ saved, requestedId, managedResume }, dependencies) {
  if (managedResume && saved && !saved.removed && saved.agentId && saved.accountId) {
    const binding = await dependencies.binding(saved.agentId);
    ensure(binding.accountId === saved.accountId, 'Persisted route and account binding disagree');
    return validateBinding(binding);
  }
  if (requestedId && saved && !saved.removed && saved.accountId && saved.accountId !== requestedId) throw new Error('Use --switch-ngrok-from to change accounts explicitly');
  return dependencies.check(requestedId || (saved && !saved.removed ? saved.accountId : ''));
}
