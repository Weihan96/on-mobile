#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandPath,
  deleteNgrokTunnel,
  fetchWithTimeout,
  getOrCreateNgrokTunnel,
  getTailscaleInfo,
  resetTailscaleServe,
  startTailscaleServe,
} from "./lib/mobile-access.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  console.log(`Usage:
  bun ${scriptPath} <markdown-file-or-directory> [--port 8642] [--access auto|tailscale|ngrok] [--https]

Starts a Markserv Markdown preview for mobile reading.

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

async function tryTailscaleDirect({ tailscale, port, pagePath }) {
  const primaryUrl = `http://${tailscale.ip4}:${port}${pagePath}`;
  const response = await waitForHtmlUrl(primaryUrl, "Tailscale Markdown page");
  const html = await response.response.text();
  const image = await verifyImage(primaryUrl, html);
  const alternates = [];
  if (tailscale.dnsName) {
    alternates.push(`http://${tailscale.dnsName}:${port}${pagePath}`);
  }
  return {
    kind: "tailscale-direct",
    url: primaryUrl,
    accessLabel: "Tailscale direct (tailnet-only HTTP)",
    alternates,
    image,
    caveat: "Phone must be connected to the same Tailscale tailnet.",
  };
}

async function tryTailscaleServe({ tailscale, port, pagePath, onServeStarted = () => {} }) {
  if (!tailscale.dnsName) {
    throw new Error("Tailscale Serve HTTPS requires a MagicDNS name");
  }

  let serveStarted = false;
  try {
    startTailscaleServe({ tailscale, localHost: "localhost", port });
    serveStarted = true;
    onServeStarted(tailscale.command);
  } catch (error) {
    throw error;
  }

  try {
    const primaryUrl = `https://${tailscale.dnsName}${pagePath}`;
    const response = await waitForHtmlUrl(primaryUrl, "Tailscale Serve Markdown page");
    const html = await response.response.text();
    const image = await verifyImage(primaryUrl, html);
    return {
      kind: "tailscale-serve",
      url: primaryUrl,
      accessLabel: "Tailscale Serve (tailnet-only HTTPS)",
      alternates: [],
      image,
      createdServe: true,
      caveat: "Phone must be connected to Tailscale; HTTPS uses this machine's MagicDNS name.",
    };
  } catch (error) {
    if (serveStarted) {
      try {
        resetTailscaleServe(tailscale.command);
        onServeStarted("");
      } catch {
        // Best-effort cleanup only; report the original verification error.
      }
    }
    throw error;
  }
}

async function tryNgrok({ port, pagePath }) {
  const tunnel = await getOrCreateNgrokTunnel(port, { namePrefix: "markserv-mobile" });
  const primaryUrl = `${tunnel.publicUrl}${pagePath}`;
  const headers = { "ngrok-skip-browser-warning": "1" };
  const response = await waitForHtmlUrl(primaryUrl, "ngrok Markdown page", headers);
  const html = await response.response.text();
  const image = await verifyImage(primaryUrl, html, headers);
  return {
    kind: "ngrok",
    url: primaryUrl,
    accessLabel: "ngrok fallback (public HTTPS)",
    alternates: [],
    image,
    createdTunnelUri: tunnel.created ? tunnel.uri : "",
    caveat: "This URL is public and may show an ngrok browser warning on mobile.",
  };
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
  const { target, port: requestedPort, access, preferHttps } = parseArgs(process.argv.slice(2));
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

  let localHtml = "";
  let localImage = { status: "none", message: "" };
  let mobile = null;
  let fallbackReason = "";
  let shuttingDown = false;
  let createdServeCommand = "";

  async function cleanup() {
    stopProcess(markserv.child);
    if (mobile?.createdTunnelUri) {
      try {
        await deleteNgrokTunnel(mobile.createdTunnelUri);
      } catch {
        // Best-effort cleanup only; ngrok tunnels can also be removed by restarting ngrok.
      }
    }
    const serveCommand = mobile?.createdServe ? createdServeCommand || getTailscaleInfo().command : createdServeCommand;
    if (serveCommand) {
      try {
        resetTailscaleServe(serveCommand);
      } catch {
        // Best-effort cleanup only; the user can run "tailscale serve reset" manually.
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
    await waitForHtmlUrl(localPageUrl, "local Markserv Markdown page");
    const localResponse = await fetchWithTimeout(localPageUrl, {}, 10000);
    localHtml = await localResponse.text();
    localImage = await verifyImage(localPageUrl, localHtml);

    if (access !== "ngrok") {
      const tailscale = getTailscaleInfo();
      if (tailscale.available) {
        try {
          mobile = preferHttps
            ? await tryTailscaleServe({
                tailscale,
                port,
                pagePath: resolved.pagePath,
                onServeStarted: (command) => {
                  createdServeCommand = command;
                },
              })
            : await tryTailscaleDirect({ tailscale, port, pagePath: resolved.pagePath });
        } catch (error) {
          fallbackReason = `Tailscale ${preferHttps ? "Serve" : "direct"} failed: ${error.message}`;
          if (!preferHttps) {
            try {
              mobile = await tryTailscaleServe({
                tailscale,
                port,
                pagePath: resolved.pagePath,
                onServeStarted: (command) => {
                  createdServeCommand = command;
                },
              });
              fallbackReason = "Direct Tailscale URL failed, so Tailscale Serve HTTPS was used.";
            } catch (serveError) {
              fallbackReason += `; Tailscale Serve fallback failed: ${serveError.message}`;
            }
          }
        }
      } else {
        fallbackReason = tailscale.reason;
      }
    }

    if (!mobile) {
      if (access === "tailscale") {
        throw new Error(fallbackReason || "Tailscale access was required but unavailable");
      }
      mobile = await tryNgrok({ port, pagePath: resolved.pagePath });
    }

    console.log("");
    console.log("Markdown mobile preview is ready.");
    console.log(`Primary URL: ${mobile.url}`);
    console.log(`Access: ${mobile.accessLabel}`);
    for (const alternate of mobile.alternates || []) {
      console.log(`Alternate URL: ${alternate}`);
    }
    console.log(`Local target: http://localhost:${port}`);
    console.log(`Serve root: ${resolved.serveRoot}`);
    console.log(`Target: ${resolved.targetPath}`);
    console.log(`Markserv: ${useBunx ? "temporary bunx fallback" : markservPath}`);
    console.log(`Local image check: ${localImage.message}`);
    console.log(`Mobile image check: ${mobile.image.message}`);
    console.log(`Log: ${markserv.logPath}`);
    if (fallbackReason && mobile.kind === "ngrok") {
      console.log(`Fallback reason: ${fallbackReason}`);
    }
    console.log(`Caveat: ${mobile.caveat}`);
    if (mobile.kind === "ngrok") {
      console.log("If ngrok shows a browser warning on mobile, tap Visit Site.");
    }
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
