import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { migrateInventory, readInventory } from '../scripts/lib/ngrok-accounts.mjs';
let dir, source, destination, bytes;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'inventory-migration-'));
  source = path.join(dir, 'legacy.env'); destination = path.join(dir, 'home/.config/on-mobile/.env');
  bytes = `ON_MOBILE_NGROK_ACCOUNTS='${JSON.stringify([{ id: 'fixture', name: 'Fixture', email: 'test@example.invalid', configPath: '/private/example.yml', domain: '', history: 'Unknown current quota' }])}'\n`;
  await fs.writeFile(source, bytes, { mode: 0o600 });
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true }));
test('migration preserves bytes, permissions and source; identical retry is safe', async () => {
  expect((await migrateInventory(source, destination)).status).toBe('migrated');
  expect(await fs.readFile(destination, 'utf8')).toBe(bytes);
  expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(destination))).mode & 0o777).toBe(0o700);
  expect(await fs.readFile(source, 'utf8')).toBe(bytes);
  expect((await migrateInventory(source, destination)).status).toBe('already-present');
  expect(await fs.readdir(path.dirname(destination))).toEqual(['.env']);
});
test('different destination is never overwritten, including concurrent migrations', async () => {
  const other = path.join(dir, 'other.env'); const otherBytes = bytes.replace('test@example.invalid', 'other@example.invalid');
  await fs.writeFile(other, otherBytes, { mode: 0o600 });
  const results = await Promise.allSettled([migrateInventory(source, destination), migrateInventory(other, destination)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect([bytes, otherBytes]).toContain(await fs.readFile(destination, 'utf8'));
  expect(await fs.readFile(source, 'utf8')).toBe(bytes); expect(await fs.readFile(other, 'utf8')).toBe(otherBytes);
});
test('migration rejects symbolic links, unsafe source permissions and invalid inventories', async () => {
  const link = path.join(dir, 'link'); await fs.symlink(source, link);
  await expect(migrateInventory(link, destination)).rejects.toThrow();
  await fs.chmod(source, 0o644); await expect(migrateInventory(source, destination)).rejects.toThrow('0600');
  await fs.chmod(source, 0o600); await fs.writeFile(source, 'not an inventory');
  await expect(migrateInventory(source, destination)).rejects.toThrow('assignment');
  expect(await fs.exists(destination)).toBe(false);
});
test('existing destination link or parent link cannot redirect migration', async () => {
  await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.symlink(source, destination);
  await expect(migrateInventory(source, destination)).rejects.toThrow();
  expect(await fs.readFile(source, 'utf8')).toBe(bytes);
  await fs.rm(path.dirname(destination), { recursive: true }); await fs.symlink(dir, path.dirname(destination));
  await expect(migrateInventory(source, destination)).rejects.toThrow('links');
});
test('replacing the whole skill tree preserves external inventory and ignores stale in-tree .env', async () => {
  const home = path.join(dir, 'home'), skill = path.join(home, '.codex/skills/on-mobile');
  await migrateInventory(source, destination);
  const before = await fs.readFile(destination);
  const moduleSource = path.resolve(import.meta.dir, '../scripts/lib/ngrok-accounts.mjs');
  async function install() {
    await fs.mkdir(path.join(skill, 'scripts/lib'), { recursive: true });
    await fs.copyFile(moduleSource, path.join(skill, 'scripts/lib/ngrok-accounts.mjs'));
    await fs.writeFile(path.join(skill, '.env'), bytes.replace('test@example.invalid', 'stale@example.invalid'), { mode: 0o600 });
  }
  function readWithDifferentCodexHome() {
    return JSON.parse(execFileSync(process.execPath, ['-e', 'const m = await import("./scripts/lib/ngrok-accounts.mjs"); console.log(JSON.stringify({path:m.inventoryFile,accounts:await m.readInventory()}))'], { cwd: skill, encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, 'different-codex-home') } }));
  }
  await install(); expect(readWithDifferentCodexHome().path).toBe(destination);
  await fs.rm(skill, { recursive: true }); await install();
  expect(readWithDifferentCodexHome().accounts[0].email).toBe('test@example.invalid');
  expect((await fs.readFile(destination)).equals(before)).toBe(true);
  expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  await fs.unlink(destination);
  await expect(readInventory(destination)).rejects.toThrow('migrate');
});

test('special files cannot block or impersonate an inventory during migration', async () => {
  await fs.unlink(source); execFileSync('mkfifo', [source]);
  await expect(migrateInventory(source, destination)).rejects.toThrow('regular file');
  expect(await fs.exists(destination)).toBe(false);
});
