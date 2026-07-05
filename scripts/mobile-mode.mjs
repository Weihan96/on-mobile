#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const skillRoot = path.resolve(scriptDir, "..");
const validModes = new Set(["off", "auto", "always"]);
const defaultMode = "auto";
const modeFile =
  process.env.CODEX_MOBILE_PREVIEW_MODE_FILE ||
  path.join(skillRoot, ".local", "mobile-preview-mode");
const metadataTemplateFile =
  process.env.CODEX_MOBILE_PREVIEW_METADATA_TEMPLATE ||
  path.join(skillRoot, "agents", "openai.yaml.template");
const metadataFile =
  process.env.CODEX_MOBILE_PREVIEW_METADATA_FILE ||
  path.join(skillRoot, "agents", "openai.yaml");

function usage() {
  console.log(`Usage:
  bun ${scriptPath} get [--json]
  bun ${scriptPath} set off|auto|always [--json]
  bun ${scriptPath} off|auto|always [--json]

Reads or writes the Codex mobile preview preference.

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
  if (command === "get" || command === "status") {
    return { command: "get", json };
  }

  if (command === "set") {
    const mode = normalizeMode(filtered[1]);
    if (!validModes.has(mode)) {
      usage();
      throw new Error("set requires one of: off, auto, always");
    }
    return { command: "set", mode, json };
  }

  const mode = normalizeMode(command);
  if (validModes.has(mode)) {
    return { command: "set", mode, json };
  }

  usage();
  throw new Error("Expected get, status, set <mode>, or a mode name");
}

async function readMode() {
  try {
    const raw = await readFile(modeFile, "utf8");
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

async function writeMode(mode) {
  await mkdir(path.dirname(modeFile), { recursive: true });
  await writeFile(modeFile, `${mode}\n`, "utf8");
  return { mode, source: "file", path: modeFile };
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
  const result = options.command === "set" ? await writeMode(options.mode) : await readMode();
  result.metadataPath = await renderMetadata(result.mode);
  result.modeBadge = modeBadge(result.mode);
  print(result, options.json);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
