#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  console.log(`Usage:
  bun ${scriptPath} <markdown-file-or-directory> [--port 8642]

Starts a Markserv Markdown preview, verifies local assets, and exposes it via
an existing ngrok agent API at http://127.0.0.1:4040.`);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  let port = 8642;
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
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    usage();
    throw new Error("Expected exactly one Markdown file or directory target");
  }

  return { target: positional[0], port };
}

function commandPath(name) {
  try {
    return execFileSync("zsh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForUrl(url, description) {
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, 5000);
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

async function getNgrokTunnels() {
  const response = await fetchWithTimeout("http://127.0.0.1:4040/api/tunnels", {}, 3000);
  if (!response.ok) {
    throw new Error(`ngrok API returned ${response.status}`);
  }
  return response.json();
}

function tunnelMatchesPort(tunnel, port) {
  const addr = tunnel?.config?.addr || "";
  return addr === `${port}` || addr.endsWith(`:${port}`) || addr === `http://localhost:${port}`;
}

async function getOrCreateTunnel(port) {
  let tunnels;
  try {
    tunnels = await getNgrokTunnels();
  } catch (error) {
    throw new Error(
      `ngrok local API is unavailable. Start ngrok first, for example: ngrok http ${port}. Details: ${error.message}`,
    );
  }

  const existing = (tunnels.tunnels || []).find((tunnel) => {
    return tunnel.proto === "https" && tunnel.public_url && tunnelMatchesPort(tunnel, port);
  });
  if (existing) {
    return { publicUrl: existing.public_url, created: false };
  }

  const response = await fetchWithTimeout(
    "http://127.0.0.1:4040/api/tunnels",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `markserv-mobile-${port}-${Date.now()}`,
        addr: `http://localhost:${port}`,
        proto: "http",
      }),
    },
    10000,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create ngrok tunnel: ${response.status} ${text}`);
  }

  const tunnel = await response.json();
  return { publicUrl: tunnel.public_url, uri: tunnel.uri, created: true };
}

function startMarkserv({ serveRoot, port, markservPath, useBunx }) {
  const logDir = path.join(os.tmpdir(), "codex-on-mobile-markserv");
  const logPath = path.join(logDir, `markserv-${port}.log`);

  return mkdir(logDir, { recursive: true }).then(() => {
    const args = [
      useBunx ? "markserv" : ".",
      ...(useBunx ? ["."] : []),
      "-p",
      String(port),
      "-a",
      "0.0.0.0",
      "--browser",
      "false",
      "--livereloadport",
      "false",
    ];

    const child = spawn(useBunx ? "bunx" : markservPath, args, {
      cwd: serveRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const log = createWriteStream(logPath, { flags: "a" });
    child.stdout.pipe(log);
    child.stderr.pipe(log);

    let exited = false;
    child.once("error", (error) => {
      exited = true;
      log.write(`\n[serve-markdown-mobile] failed to start markserv: ${error.message}\n`);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      log.write(`\n[serve-markdown-mobile] markserv exited code=${code} signal=${signal}\n`);
    });

    return { child, logPath, didExit: () => exited };
  });
}

function stopProcess(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
}

async function main() {
  const { target, port: requestedPort } = parseArgs(process.argv.slice(2));
  const resolved = resolveTarget(target);
  const port = await choosePort(requestedPort);

  const markservPath = commandPath("markserv");
  const bunPath = commandPath("bun");
  const useBunx = !markservPath;
  if (useBunx && !bunPath) {
    throw new Error("markserv is not installed and bun is unavailable for bunx fallback");
  }

  const markserv = await startMarkserv({
    serveRoot: resolved.serveRoot,
    port,
    markservPath,
    useBunx,
  });

  let publicUrl = "";
  let localHtml = "";
  let localImage = { status: "none", message: "" };
  let publicImage = { status: "none", message: "" };
  let createdTunnelUri = "";
  let shuttingDown = false;

  async function cleanup() {
    stopProcess(markserv.child);
    if (createdTunnelUri) {
      try {
        await fetchWithTimeout(`http://127.0.0.1:4040${createdTunnelUri}`, { method: "DELETE" }, 3000);
      } catch {
        // Best-effort cleanup only; ngrok tunnels can also be removed by restarting ngrok.
      }
    }
  }

  async function shutdown(exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanup();
    process.exit(exitCode);
  }

  process.once("SIGINT", () => {
    void shutdown(130);
  });
  process.once("SIGTERM", () => {
    void shutdown(143);
  });

  try {
    const localPageUrl = `http://127.0.0.1:${port}${resolved.pagePath}`;
    await waitForUrl(localPageUrl, "local Markserv Markdown page");
    const localResponse = await fetchWithTimeout(localPageUrl, {}, 10000);
    localHtml = await localResponse.text();
    localImage = await verifyImage(localPageUrl, localHtml);

    const tunnel = await getOrCreateTunnel(port);
    if (tunnel.created) {
      createdTunnelUri = tunnel.uri;
    }
    publicUrl = `${tunnel.publicUrl}${resolved.pagePath}`;

    const publicResponse = await fetchWithTimeout(
      publicUrl,
      { headers: { "ngrok-skip-browser-warning": "1" } },
      20000,
    );
    if (!publicResponse.ok) {
      throw new Error(`Public Markdown page returned ${publicResponse.status}`);
    }
    const publicHtml = await publicResponse.text();
    publicImage = await verifyImage(publicUrl, publicHtml, {
      "ngrok-skip-browser-warning": "1",
    });

    console.log("");
    console.log("Markdown mobile preview is ready.");
    console.log(`Public URL: ${publicUrl}`);
    console.log(`Local target: http://localhost:${port}`);
    console.log(`Serve root: ${resolved.serveRoot}`);
    console.log(`Target: ${resolved.targetPath}`);
    console.log(`Markserv: ${useBunx ? "temporary bunx fallback" : markservPath}`);
    console.log(`Local image check: ${localImage.message}`);
    console.log(`Public image check: ${publicImage.message}`);
    console.log(`Log: ${markserv.logPath}`);
    console.log("");
    console.log("If ngrok shows a browser warning on mobile, tap Visit Site.");
    if (useBunx) {
      console.log("For repeated use, install Markserv persistently:");
      console.log("  bun add -g markserv");
    }
    console.log("");
    console.log("Keep this process running while you use the preview. Press Ctrl+C to stop.");

    await new Promise((resolve) => {
      markserv.child.once("exit", resolve);
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
