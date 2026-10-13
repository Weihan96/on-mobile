#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandPath, fetchWithTimeout } from "./lib/mobile-access.mjs";
import { readService } from "./mobile-service.mjs";
const scriptPath = fileURLToPath(import.meta.url);
const manager = path.join(path.dirname(scriptPath), "mobile-service.mjs");
const urlHelper = path.join(path.dirname(scriptPath), "mobile-url-for-port.mjs");
function usage() {
  console.log(`Usage:
  bun ${scriptPath} <markdown-file-or-directory> [--port 8642] [--access auto|tailscale|ngrok] [--https]

Starts a launchd-managed Markserv preview, retained until explicit completion or seven days.

Default behavior:
  1. Serve Markdown locally with Markserv.
  2. Prefer a verified Tailscale URL for the user's own mobile device.
  3. Fall back to ngrok when Tailscale is unavailable or cannot be verified.

Options:
  --port, -p <port>       Preferred local Markserv port. Defaults to 8642.
  --access <mode>         auto, tailscale, or ngrok. Defaults to auto.
  --tailscale             Alias for --access tailscale.
  --ngrok                 Alias for --access ngrok.
  --https                 Prefer Tailscale Serve HTTPS instead of direct HTTP.
`);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  let port = 8642;
  let access = "auto";
  let preferHttps = false;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      const next = args[i + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("--port requires a numeric value");
      }
      port = Number(next);
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
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    usage();
    throw new Error("Expected exactly one Markdown file or directory target");
  }

  return { target: positional[0], port, access, preferHttps };
}

function gitRootFor(targetPath) {
  const cwd = statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function encodePathname(value) {
  return value
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveTarget(input) {
  const targetPath = path.resolve(input);
  if (!existsSync(targetPath)) {
    throw new Error(`Target does not exist: ${targetPath}`);
  }

  const stat = statSync(targetPath);
  const gitRoot = gitRootFor(targetPath);
  const serveRoot = gitRoot || (stat.isDirectory() ? targetPath : path.dirname(targetPath));
  const relative = path.relative(serveRoot, targetPath);
  const pagePath = stat.isDirectory()
    ? `/${encodePathname(relative)}/`.replace(/\/{2,}/g, "/")
    : `/${encodePathname(relative)}`;

  return {
    targetPath,
    serveRoot,
    pagePath: pagePath === "//" ? "/" : pagePath,
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function choosePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + 99}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHtmlUrl(url, description, headers = {}) {
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { headers }, 5000);
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && contentType.includes("text/html")) {
        return { response, contentType };
      }
      lastError = `${response.status} ${contentType}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}: ${url} (${lastError})`);
}

function firstLocalImageSrc(html) {
  const imageRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(imageRegex)) {
    const src = match[1];
    if (
      !src ||
      src.startsWith("data:") ||
      src.startsWith("http://") ||
      src.startsWith("https://") ||
      src.startsWith("//")
    ) {
      continue;
    }
    return src;
  }
  return "";
}

async function verifyImage(pageUrl, html, headers = {}) {
  const src = firstLocalImageSrc(html);
  if (!src) {
    return { status: "none", message: "No local image found in rendered HTML" };
  }

  const imageUrl = new URL(src, pageUrl).toString();
  const response = await fetchWithTimeout(imageUrl, { headers }, 10000);
  if (!response.ok) {
    return {
      status: "failed",
      url: imageUrl,
      message: `First local image returned ${response.status}`,
    };
  }

  return {
    status: "ok",
    url: imageUrl,
    message: `First local image returned ${response.status}`,
  };
}


async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveTarget(options.target);
  const markserv = commandPath("markserv");
  if (!markserv) throw new Error("Durable previews require installed Markserv. Install with: bun add -g markserv");
  const id = process.env.ON_MOBILE_SERVICE_ID;
  if (!id) {
    const port = await choosePort(options.port);
    const args = [scriptPath, resolved.targetPath, "--port", String(port), "--access", options.access];
    if (options.preferHttps) args.push("--https");
    const service = JSON.parse(execFileSync(process.execPath,
      [manager, "start", "--cwd", resolved.serveRoot, "--port", String(port), "--", process.execPath, ...args],
      { encoding: "utf8", timeout: 60000 }));
    for (let attempt = 0; attempt < 90; attempt++) {
      const current = await readService(service.id);
      const preview = path.join(current.directory, "preview.json");
      if (existsSync(preview) && current.status === "running") {
        const result = JSON.parse(readFileSync(preview, "utf8"));
        if (result.helperPid !== current.childPid || result.workerPid !== current.workerPid) { await sleep(1000); continue; }
        // The launching command can exit now; launchd owns the entire preview.
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      await sleep(1000);
    }
    throw new Error(`Preview not ready; inspect mobile-service.mjs status ${service.id}. It remains managed until stopped/expired.`);
  }
  const service = await readService(id);
  if (service.port !== options.port) throw new Error("Managed preview port does not match its receipt");
  const child = spawn(process.execPath, [markserv, ".", "-p", String(options.port), "-a", "0.0.0.0", "--browser", "false", "--livereloadport", "false"],
    { cwd: resolved.serveRoot, stdio: "inherit", env: process.env });
  let childEnded = false;
  const ended = new Promise((resolve, reject) => {
    child.once("error", error => { childEnded = true; reject(error); });
    child.once("exit", (code, signal) => { childEnded = true; resolve({ code, signal }); });
  });
  // Observe early failures while readiness probes run.
  ended.catch(() => {});
  const guard = promise => Promise.race([promise, ended.then(() => { throw new Error("Markserv exited during readiness"); })]);
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.once("SIGINT", () => child.kill("SIGTERM"));
  try {
    const localUrl = `http://127.0.0.1:${options.port}${resolved.pagePath}`;
    const local = await guard(waitForHtmlUrl(localUrl, "local Markdown"));
    const localImage = await guard(verifyImage(localUrl, await local.response.text()));
    const args = [urlHelper, String(options.port), "--service", id, "--path", resolved.pagePath, "--access", options.access, "--json"];
    if (options.preferHttps) args.push("--https");
    const result = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", timeout: 75000 }));
    const mobile = await guard(waitForHtmlUrl(result.primaryUrl, "mobile Markdown",
      result.access === "ngrok" ? { "ngrok-skip-browser-warning": "1" } : {}));
    const mobileImage = await verifyImage(result.primaryUrl, await mobile.response.text(),
      result.access === "ngrok" ? { "ngrok-skip-browser-warning": "1" } : {});
    if (childEnded) throw new Error("Markserv exited before publication");
    const receipt = path.join(service.directory, "preview.json");
    const temporary = `${receipt}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...result, workerPid: service.workerPid, helperPid: process.pid, localImage, mobileImage, serveRoot: resolved.serveRoot, markserv }, null, 2));
    renameSync(temporary, receipt);
    const exit = await ended;
    throw new Error(`Markserv exited: ${JSON.stringify(exit)}`);
  } finally { child.kill("SIGTERM"); }
}
main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
