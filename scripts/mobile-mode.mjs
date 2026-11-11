#!/usr/bin/env bun

import { mkdir, readFile, writeFile, open, lstat, rename, link, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const skillRoot = path.resolve(scriptDir, "..");
const validModes = new Set(["off", "auto", "always"]);
const defaultMode = "auto";
// A user preference, independent of replaceable skills and CODEX_HOME.
const modeFile = path.join(os.homedir(), ".config/on-mobile/mobile-preview-mode");
const metadataTemplateFile =
  process.env.CODEX_MOBILE_PREVIEW_METADATA_TEMPLATE ||
  path.join(skillRoot, "agents", "openai.yaml.template");
const metadataFile =
  process.env.CODEX_MOBILE_PREVIEW_METADATA_FILE ||
  path.join(skillRoot, "agents", "openai.yaml");

function usage() {
  console.log(`Usage:
  bun ${scriptPath} get [--json]
  bun ${scriptPath} migrate --from ABS_LEGACY_MODE_FILE [--json]
  bun ${scriptPath} set off|auto|always [--json]
  bun ${scriptPath} off|auto|always [--json]

Reads or writes the persistent Codex mobile preview preference outside the skill.
Migration retains the old file and never overwrites a different saved preference.

Modes:
  off       Do not proactively use on-mobile unless explicitly requested.
  auto      Use on-mobile for strong local-link, preview, callback, or mobile signals.
  always    Default to on-mobile for openable local services, previews, and Markdown reading.

State file:
  ${modeFile}

Generated UI metadata:
  ${metadataFile}

If the state file is missing or invalid, get reports the default mode: ${defaultMode}.
`);
}

function normalizeMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "on") return "always";
  return normalized;
}

function modeBadge(mode) {
  if (mode === "always") return "🟢 always";
  if (mode === "off") return "⚪ off";
  return "📱 auto";
}

function parseArgs(argv) {
  const args = [...argv];
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json");

  if (filtered.includes("--help") || filtered.includes("-h")) {
    usage();
    process.exit(0);
  }

  const command = filtered[0] || "get";
  if (command === "migrate") {
    if (filtered.length !== 3 || filtered[1] !== "--from" || !path.isAbsolute(filtered[2])) throw new Error("migrate --from requires one absolute legacy mode-file path");
    return { command, from: filtered[2], json };
  }

  if (command === "get" || command === "status") {
    if (filtered.length > 1) throw new Error("get does not take positional arguments");
    return { command: "get", json };
  }

  if (command === "set") {
    const mode = normalizeMode(filtered[1]);
    if (filtered.length !== 2 || !validModes.has(mode)) {
      usage();
      throw new Error("set requires one of: off, auto, always");
    }
    return { command: "set", mode, json };
  }

  const mode = normalizeMode(command);
  if (filtered.length === 1 && validModes.has(mode)) {
    return { command: "set", mode, json };
  }

  usage();
  throw new Error("Expected get, status, set <mode>, or a mode name");
}

async function readMode() {
  try {
    const raw = await readRegular(modeFile);
    const mode = normalizeMode(raw);
    if (validModes.has(mode)) {
      return { mode, source: "file", path: modeFile };
    }
    return { mode: defaultMode, source: "default-invalid-file", path: modeFile };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { mode: defaultMode, source: "default-missing-file", path: modeFile };
    }
    throw error;
  }
}

async function readRegular(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error("Mode preference must be an owned regular file, not a link or special file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function prepareDirectory() {
  for (let p = path.dirname(modeFile); ; p = path.dirname(p)) {
    try {
      const stat = await lstat(p);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Mode config directory must not traverse links");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (p === path.dirname(p)) break;
  }
  await mkdir(path.dirname(modeFile), { recursive: true, mode: 0o700 });
}

async function storeMode(mode, migrate = false) {
  await prepareDirectory();
  // Reject links/special files before a normal, explicitly requested replacement.
  if (!migrate) {
    try { await readRegular(modeFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const temp = path.join(path.dirname(modeFile), `.mode-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${mode}\n`); await handle.sync(); } finally { await handle.close(); }
    if (migrate) {
      try { await link(temp, modeFile); }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (normalizeMode(await readRegular(modeFile)) !== mode) throw new Error("External mode differs; both preferences retained without overwriting. Choose explicitly before changing it.");
        return { mode, source: "migration-existing", path: modeFile, sourceRetained: true };
      }
    } else await rename(temp, modeFile);
    if (normalizeMode(await readRegular(modeFile)) !== mode) throw new Error("Mode changed during verification; inspect before retrying");
    return { mode, source: migrate ? "migrated" : "file", path: modeFile, ...(migrate ? { sourceRetained: true } : {}) };
  } finally { await rm(temp, { force: true }); }
}

async function migrateMode(from) {
  const mode = normalizeMode(await readRegular(from));
  if (!validModes.has(mode)) throw new Error("Legacy mode is invalid; nothing migrated or reset to auto");
  return storeMode(mode, true);
}

async function renderMetadata(mode) {
  const template = await readFile(metadataTemplateFile, "utf8");
  const rendered = template
    .replaceAll("{{mode}}", mode)
    .replaceAll("{{mode_badge}}", modeBadge(mode));
  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(metadataFile, rendered, "utf8");
  return metadataFile;
}

function print(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Mobile preview mode: ${result.mode}`);
  console.log(`Source: ${result.source}`);
  console.log(`State file: ${result.path}`);
  console.log(`UI metadata: ${result.metadataPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === "set" ? await storeMode(options.mode) : options.command === "migrate" ? await migrateMode(options.from) : await readMode();
  result.metadataPath = await renderMetadata(result.mode);
  result.modeBadge = modeBadge(result.mode);
  print(result, options.json);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
