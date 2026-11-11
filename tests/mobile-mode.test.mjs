import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
let root, home, skill, modeFile;
const source = path.resolve(import.meta.dir, '..');
async function install() {
  await fs.mkdir(path.join(skill, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(skill, 'agents'), { recursive: true });
  await fs.copyFile(path.join(source, 'scripts/mobile-mode.mjs'), path.join(skill, 'scripts/mobile-mode.mjs'));
  await fs.copyFile(path.join(source, 'agents/openai.yaml.template'), path.join(skill, 'agents/openai.yaml.template'));
}
function run(args, extra = {}) {
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, 'different-codex'), CODEX_MOBILE_PREVIEW_MODE_FILE: path.join(skill, '.local/mobile-preview-mode'), ...extra };
  delete env.CODEX_MOBILE_PREVIEW_METADATA_FILE; delete env.CODEX_MOBILE_PREVIEW_METADATA_TEMPLATE;
  return spawnSync(process.execPath, [path.join(skill, 'scripts/mobile-mode.mjs'), ...args, '--json'], { cwd: skill, env, encoding: 'utf8', timeout: 5000 });
}
function ok(args) { const result = run(args); expect(result.status).toBe(0); return JSON.parse(result.stdout); }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'mobile-mode-'));
  home = path.join(root, 'home'); skill = path.join(home, '.codex/skills/on-mobile'); modeFile = path.join(home, '.config/on-mobile/mobile-preview-mode');
  await install();
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));
test('all three modes survive whole-directory reinstall and regenerate the correct badge', async () => {
  for (const [mode, badge] of [['off', '⚪ off'], ['auto', '📱 auto'], ['always', '🟢 always']]) {
    expect(ok(['set', mode]).path).toBe(modeFile);
    const before = await fs.readFile(modeFile);
    await fs.rm(skill, { recursive: true }); await install();
    await fs.mkdir(path.join(skill, '.local')); await fs.writeFile(path.join(skill, '.local/mobile-preview-mode'), mode === 'off' ? 'always' : 'off');
    const read = ok(['get']); expect(read.mode).toBe(mode); expect(read.modeBadge).toBe(badge);
    expect((await fs.readFile(modeFile)).equals(before)).toBe(true);
    expect((await fs.stat(modeFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(skill, 'agents/openai.yaml'), 'utf8')).toContain(badge);
  }
});
test('legacy migration retains source and accepts same preference without overwriting it', async () => {
  const old = path.join(root, 'legacy-mode'); await fs.writeFile(old, 'off\n');
  expect(ok(['migrate', '--from', old]).source).toBe('migrated');
  const stat = await fs.stat(modeFile);
  expect(ok(['migrate', '--from', old]).source).toBe('migration-existing');
  expect((await fs.stat(modeFile)).ino).toBe(stat.ino);
  expect(await fs.readFile(old, 'utf8')).toBe('off\n');
  await fs.writeFile(old, 'always\n'); expect(run(['migrate', '--from', old]).status).toBe(1);
  expect(await fs.readFile(modeFile, 'utf8')).toBe('off\n'); expect(await fs.readFile(old, 'utf8')).toBe('always\n');
});
test('missing or invalid external mode reports auto without rewriting stored preference', async () => {
  expect(ok(['get']).source).toBe('default-missing-file'); expect(await fs.exists(modeFile)).toBe(false);
  await fs.mkdir(path.dirname(modeFile), { recursive: true }); await fs.writeFile(modeFile, 'invalid\n');
  const result = ok(['get']); expect(result.mode).toBe('auto'); expect(result.source).toBe('default-invalid-file');
  expect(await fs.readFile(modeFile, 'utf8')).toBe('invalid\n');
  const old = path.join(root, 'legacy-mode'); await fs.writeFile(old, 'invalid');
  expect(run(['migrate', '--from', old]).status).toBe(1); expect(await fs.readFile(modeFile, 'utf8')).toBe('invalid\n');
});
test('set on still means always and mode changes leave the neighboring account inventory untouched', async () => {
  await fs.mkdir(path.dirname(modeFile), { recursive: true });
  const inventory = path.join(path.dirname(modeFile), '.env'); await fs.writeFile(inventory, 'private fixture only\n', { mode: 0o600 });
  expect(ok(['on']).mode).toBe('always'); expect(ok(['off']).mode).toBe('off');
  expect(await fs.readFile(inventory, 'utf8')).toBe('private fixture only\n');
  expect((await fs.stat(inventory)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(path.dirname(modeFile))).toEqual(expect.arrayContaining(['.env', 'mobile-preview-mode']));
  expect((await fs.readdir(path.dirname(modeFile))).some(n => n.startsWith('.mode-'))).toBe(false);
});
test('links and special files cannot redirect or hang preference reads, writes or migration', async () => {
  const target = path.join(root, 'target'); await fs.writeFile(target, 'off\n');
  await fs.mkdir(path.dirname(modeFile), { recursive: true }); await fs.symlink(target, modeFile);
  for (const args of [['get'], ['set', 'always'], ['migrate', '--from', target]]) expect(run(args).status).toBe(1);
  expect(await fs.readFile(target, 'utf8')).toBe('off\n');
  await fs.unlink(modeFile); execFileSync('mkfifo', [modeFile]);
  expect(run(['get']).status).toBe(1); expect(run(['set', 'always']).status).toBe(1);
});
