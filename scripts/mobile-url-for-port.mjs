#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createManager, readService, registerCleanup, withServiceResourceLock } from "./mobile-service.mjs";
import { getTailscaleInfo, probeUrl, commandPath } from "./lib/mobile-access.mjs";
import { isOwnedNgrokAgent, validateNgrokReceipt } from "./mobile-ngrok.mjs";
const scriptPath = fileURLToPath(import.meta.url);
const ngrokWrapper = path.join(path.dirname(scriptPath), "mobile-ngrok.mjs");
const manager = () => createManager({ stateRoot: process.env.ON_MOBILE_STATE_ROOT, agentsRoot: process.env.ON_MOBILE_AGENTS_ROOT });
function usage() {
  console.log(`Usage:
  bun ${scriptPath} <port> [--path /] [--access auto|tailscale|ngrok] [--https] [--json] --service <id>

Builds and verifies a phone-accessible URL for a local server that is already
running on the development machine.

Default behavior:
  1. Probe the local target.
  2. Prefer a verified Tailscale URL for the user's own mobile device.
  3. Fall back to ngrok when Tailscale is unavailable or cannot be verified.

Options:
  --service <id>         Managed origin service from mobile-service.mjs. Required.
  --path <path>           Path to append to the URL. Defaults to /.
  --access <mode>         auto, tailscale, or ngrok. Defaults to auto.
  --tailscale             Alias for --access tailscale.
  --ngrok                 Alias for --access ngrok.
  --https                 Prefer Tailscale Serve HTTPS instead of direct HTTP.
  --local-host <host>     Local host to probe and expose. Defaults to 127.0.0.1.
  --timeout <ms>          Probe timeout. Defaults to 5000.
  --json                  Print machine-readable JSON only.
`);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  let serviceId = process.env.ON_MOBILE_SERVICE_ID || "";
  let access = "auto";
  let urlPath = "/";
  let preferHttps = false;
  let json = false;
  let localHost = "127.0.0.1";
  let timeoutMs = 5000;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--service") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires an id`);
      serviceId = value;
    } else if (arg === "--path") {
      const next = args[i + 1];
      if (!next) throw new Error("--path requires a value");
      urlPath = normalizePath(next);
      i += 1;
    } else if (arg === "--access") {
      const next = args[i + 1];
      if (!["auto", "tailscale", "ngrok"].includes(next)) {
        throw new Error("--access must be one of: auto, tailscale, ngrok");
      }
      access = next;
      i += 1;
    } else if (arg === "--tailscale") {
      access = "tailscale";
    } else if (arg === "--ngrok") {
      access = "ngrok";
    } else if (arg === "--https") {
      preferHttps = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--local-host") {
      const next = args[i + 1];
      if (!next) throw new Error("--local-host requires a value");
      localHost = next;
      i += 1;
    } else if (arg === "--timeout") {
      const next = args[i + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("--timeout requires a numeric value");
      }
      timeoutMs = Number(next);
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1 || Number.isNaN(Number(positional[0]))) {
    usage();
    throw new Error("Expected exactly one numeric port");
  }

  return {
    serviceId,
    port: Number(positional[0]),
    path: urlPath,
    access,
    preferHttps,
    json,
    localHost,
    timeoutMs,
  };
}

function normalizePath(value) {
  if (!value || value === "/") return "/";
  if (/^https?:\/\//.test(value)) {
    throw new Error("--path must be a path, not a full URL");
  }
  return value.startsWith("/") ? value : `/${value}`;
}


function routeFile(service) { return path.join(service.directory, "route.json"); }
function loadRoute(service) {
  return existsSync(routeFile(service)) ? JSON.parse(readFileSync(routeFile(service), "utf8")) : null;
}
export function saveRoute(service, route) {
  const destination = routeFile(service), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(route, null, 2), { flag: "wx", mode: 0o600 }); renameSync(temporary, destination); }
  finally { rmSync(temporary, { force: true }); }
}
function serveConfig(command) {
  return JSON.parse(execFileSync(command, ["serve", "status", "--json"], { encoding: "utf8", timeout: 10000, env: { ...process.env, TERM: "xterm-256color" } }));
}
function serveHandler(config, route) { return config.Web?.[route.host]?.Handlers; }

// The receipt names one endpoint. Never reset the machine-wide Serve config.
async function cleanupRouteUnlocked(service) {
  const route = loadRoute(service);
  if (!route || route.removed) return;
  if (route.kind === "tailscale-serve") {
    const config = serveConfig(route.command);
    const handlers = serveHandler(config, route);
    if (handlers) {
      if (JSON.stringify(handlers) !== JSON.stringify({ "/": { Proxy: route.target } })) {
        throw new Error("Serve endpoint changed ownership; retained for inspection");
      }
      execFileSync(route.command, ["serve", `--https=${route.httpsPort}`, "off"], { timeout: 15000, env: { ...process.env, TERM: "xterm-256color" } });
    } else if (config.TCP?.[route.httpsPort]) {
      throw new Error("Serve port was repurposed; refusing to remove it");
    }
  } else if (route.kind === "ngrok") {
    // A missing bootstrap response can leave agentId unset. Recover only agents
    // whose immutable argv explicitly names this exact origin and port.
    const agents = route.agentId ? [await readService(route.agentId)] : (await manager().list()).filter(a => isOwnedNgrokAgent(a, service.id, service.port));
    for (const agent of agents) {
      if (!isOwnedNgrokAgent(agent, service.id, service.port)) throw new Error("ngrok agent ownership changed; refusing cleanup");
      await manager().stop(agent.id);
      let closed = false;
      for (let i = 0; i < 12; i++) {
        if ((await readService(agent.id)).status === "closed") { closed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!closed) throw new Error("Owned ngrok agent cleanup still pending");
    }
  }
  saveRoute(service, { ...route, removed: true });
}

export async function cleanupRoute(service) {
  return withServiceResourceLock(service.id, () => cleanupRouteUnlocked(service));
}
function assertListenerOwned(service, port) {
  const raw = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 5000 });
  const pids = [...raw.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1]));
  if (!pids.length) throw new Error("No listener for managed service");
  for (let pid of pids) {
    let owned = false;
    for (let depth = 0; pid > 1 && depth < 64; depth++) {
      if (pid === service.childPid) { owned = true; break; }
      pid = Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 3000 }).trim());
    }
    if (!owned) throw new Error("Port listener is not the managed child or its descendant");
  }
}
async function activeService(id, port) {
  if (!id) throw new Error("A durable origin is required. Start it with mobile-service.mjs, then pass --service ID.");
  const service = await readService(id);
  if (service.port !== port || service.status !== "running" || Date.now() >= Date.parse(service.expiresAt)) {
    throw new Error("Service is not running, expired, or does not own this port");
  }
  assertListenerOwned(service, port);
  return service;
}

async function createServeUnlocked(service, tailscale, port) {
  await activeService(service.id, port);
  const previous = loadRoute(service);
  if (previous && !previous.removed) {
    if (previous.kind !== "tailscale-serve") throw new Error("Service already owns another route; do not replace a delivered URL");
    const handlers = serveHandler(serveConfig(previous.command), previous);
    if (JSON.stringify(handlers) !== JSON.stringify({ "/": { Proxy: previous.target } })) {
      throw new Error("Existing Serve route is missing or changed; cannot silently change the delivered URL");
    }
    return previous;
  }
  return withServiceResourceLock(service.id, async () => {
    const config = serveConfig(tailscale.command);
    const used = new Set(Object.keys(config.TCP || {}).map(Number));
    let httpsPort = 18443;
    while (used.has(httpsPort) || httpsPort === port) httpsPort++;
    if (httpsPort > 65535) throw new Error("No free Serve port");
    const route = { kind: "tailscale-serve", command: tailscale.command, httpsPort,
      host: `${tailscale.dnsName}:${httpsPort}`, target: `http://127.0.0.1:${port}`,
      baseUrl: `https://${tailscale.dnsName}:${httpsPort}` };
    // Persist cleanup intent before creating the resource, including partial failures.
    saveRoute(service, route);
    await registerCleanup(service.id, [process.execPath, scriptPath, "cleanup", "--service", service.id]);
    await activeService(service.id, port);
    execFileSync(tailscale.command, ["serve", "--bg", "--yes", `--https=${httpsPort}`, route.target], { timeout: 20000, env: { ...process.env, TERM: "xterm-256color" } });
    return route;
  }, true);
}

async function ngrokRouteUnlocked(service, options) {
  await activeService(service.id, options.port);
  const saved = loadRoute(service);
  if (saved && !saved.removed && saved.kind !== "ngrok") throw new Error("Cannot replace a delivered service route");
  let agentId = saved && !saved.removed ? saved.agentId : null;
  if (!agentId) {
    const executable = commandPath("ngrok");
    if (!path.isAbsolute(executable)) throw new Error("ngrok executable not found");
    saveRoute(service, { kind: "ngrok", ownedAgent: true, agentId: null });
    await registerCleanup(service.id, [process.execPath, scriptPath, "cleanup", "--service", service.id]);
    // Reconcile a prior bootstrap whose response was lost before trying again.
    const candidates = (await manager().list()).filter(a => a.status !== "closed" && isOwnedNgrokAgent(a, service.id, options.port));
    if (candidates.length > 1) throw new Error("Multiple owned ngrok agents require cleanup before retry");
    const agent = candidates[0] || await manager().start({ cwd: service.directory, port: 4040,
      argv: [process.execPath, ngrokWrapper, service.id, String(options.port), executable] });
    agentId = agent.id;
    saveRoute(service, { kind: "ngrok", ownedAgent: true, agentId });
  }
  let lastError = "not ready";
  const readinessDeadline = performance.now() + 60000;
  while (performance.now() < readinessDeadline) {
    try {
      await activeService(service.id, options.port);
      const agent = await activeService(agentId, 4040);
      if (!isOwnedNgrokAgent(agent, service.id, options.port)) throw new Error("ngrok agent does not belong to this origin");
      if (Date.parse(agent.expiresAt) < Date.parse(service.expiresAt)) throw new Error("ngrok agent lifetime does not cover origin");
      const receipt = JSON.parse(readFileSync(path.join(agent.directory, "ngrok.json"), "utf8"));
      validateNgrokReceipt(receipt, agent, service.id, options.port);
      if (saved?.baseUrl && saved.baseUrl !== receipt.baseUrl) throw new Error("Delivered ngrok URL changed; refusing replacement");
      const route = { kind: "ngrok", ownedAgent: true, agentId, name: receipt.name, target: receipt.target, baseUrl: receipt.baseUrl };
      saveRoute(service, route);
      return { route, agent };
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Managed ngrok agent ${agentId} is not ready: ${lastError}; cleanup receipt retained`);
}

async function main() {
  if (process.argv[2] === "cleanup") {
    const id = process.argv[process.argv.indexOf("--service") + 1];
    await cleanupRoute(await readService(id));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.localHost !== "127.0.0.1" && options.localHost !== "localhost") throw new Error("Managed origin must be local loopback");
  const service = await activeService(options.serviceId, options.port);
  const localTarget = `http://127.0.0.1:${options.port}${options.path}`;
  const localProbe = await probeUrl(localTarget, options.timeoutMs);
  if (!localProbe.ok) throw new Error(`Origin probe failed: ${localProbe.error || localProbe.status}`);
  let url, access, expiresAt = service.expiresAt, failure = "";
  const previous = loadRoute(service);
  if (previous && !previous.removed) {
    options.access = previous.kind === "ngrok" ? "ngrok" : "tailscale";
    options.preferHttps = previous.kind === "tailscale-serve";
  }
  if (options.access !== "ngrok") {
    const tailscale = getTailscaleInfo();
    if (tailscale.available) {
      if (!options.preferHttps && !previous) {
        const direct = `http://${tailscale.ip4}:${options.port}${options.path}`;
        if ((await probeUrl(direct, options.timeoutMs)).ok) { url = direct; access = "tailscale-direct"; }
      }
      if (!url && tailscale.dnsName) {
        try {
          const route = await withServiceResourceLock(service.id, () => createServeUnlocked(service, tailscale, options.port));
          url = `${route.baseUrl}${options.path}`; access = route.kind;
        } catch (error) { failure = error.message; }
      }
    } else failure = tailscale.reason;
  }
  if (!url) {
    if (options.access === "tailscale" || loadRoute(service)?.removed === false || loadRoute(service)?.kind === "tailscale-serve") {
      throw new Error(failure || "Tailscale unavailable; retained any route receipt for scoped cleanup");
    }
    const result = await withServiceResourceLock(service.id, () => ngrokRouteUnlocked(service, options));
    url = `${result.route.baseUrl}${options.path}`; access = "ngrok";
    expiresAt = new Date(Math.min(Date.parse(expiresAt), Date.parse(result.agent.expiresAt))).toISOString();
  }
  const mobileProbe = await probeUrl(url, options.timeoutMs);
  if (!mobileProbe.ok) throw new Error(`Mobile URL probe failed: ${mobileProbe.error || mobileProbe.status}`);
  await activeService(service.id, options.port);
  const result = { primaryUrl: url, access, visibility: access === "ngrok" ? "public" : "tailnet-only",
    localTarget, localProbe, mobileProbe, serviceId: service.id, createdAt: service.createdAt, expiresAt,
    cleanupCommand: `bun ${path.join(path.dirname(scriptPath), "mobile-service.mjs")} stop ${service.id}`,
    caveat: "Kept until explicit user completion or expiry. Host power/network/login and tailnet access still matter; sleep does not extend expiry." };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Primary URL: ${url}\nAccess: ${result.visibility}\nService: ${service.id}\nExpires: ${expiresAt}\nCleanup after user confirmation: ${result.cleanupCommand}\n${result.caveat}`);
}
if (import.meta.main) main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
