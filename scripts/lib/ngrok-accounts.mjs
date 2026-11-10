/** Private account inventory; configuration files remain the only credential store. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const inventoryFile = path.join(root, '.env');
export const checksFile = path.join(root, '.local/ngrok-checks.json');
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
export async function readInventory(file = inventoryFile) {
  try { return parseInventory(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('No local .env account inventory; see references/ngrok-fallback.md'); throw e; }
}
export async function configFingerprint(file) {
  const stat = await fs.lstat(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid(), 'ngrok config must be an owned regular file with private permissions (0600)');
  // Hash in memory; never print, copy, parse or persist the credential contents.
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
export async function readChecks(file = checksFile) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export async function recordCheck(account, { identity, quota, source }, file = checksFile) {
  ensure(identity === account.email, 'Checked identity must exactly match this account email');
  ensure(['available', 'exhausted', 'unknown'].includes(quota) && source === 'dashboard', 'Check the selected account in the dashboard; quota must be available, exhausted or unknown');
  const configHash = await configFingerprint(account.configPath);
  const checks = await readChecks(file);
  checks[account.id] = { identity, quota, source, checkedAt: new Date().toISOString(), configHash };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(checks, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
  return checks[account.id];
}
export async function checkedAccount(id, { inventory = inventoryFile, checks = checksFile, now = Date.now() } = {}) {
  const account = (await readInventory(inventory)).find(a => a.id === id);
  ensure(account, 'Choose an account ID from mobile-ngrok-accounts.mjs list');
  const checked = (await readChecks(checks))[id], configHash = await configFingerprint(account.configPath);
  const age = now - Date.parse(checked?.checkedAt);
  ensure(checked?.identity === account.email && checked.source === 'dashboard' && checked.quota === 'available' && checked.configHash === configHash && age >= 0 && age <= 30 * 60 * 1000, 'Account identity and available quota require a dashboard check within 30 minutes for this exact config; historical usage is not current quota');
  return { accountId: id, configPath: account.configPath, configHash, domain: account.domain ? new URL(account.domain).origin : "" };
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
