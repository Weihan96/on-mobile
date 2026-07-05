#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  formatProbe,
  getOrCreateNgrokTunnel,
  getTailscaleInfo,
  probeUrl,
  resetTailscaleServe,
  startTailscaleServe,
} from "./lib/mobile-access.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  console.log(`Usage:
  bun ${scriptPath} <port> [--path /] [--access auto|tailscale|ngrok] [--https] [--json]

Builds and verifies a phone-accessible URL for a local server that is already
running on the development machine.

Default behavior:
  1. Probe the local target.
  2. Prefer a verified Tailscale URL for the user's own mobile device.
  3. Fall back to ngrok when Tailscale is unavailable or cannot be verified.

Options:
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

  let access = "auto";
  let urlPath = "/";
  let preferHttps = false;
  let json = false;
  let localHost = "127.0.0.1";
  let timeoutMs = 5000;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--path") {
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

async function tryTailscaleDirect({ tailscale, port, path, timeoutMs }) {
  const primaryUrl = `http://${tailscale.ip4}:${port}${path}`;
  const probe = await probeUrl(primaryUrl, timeoutMs);
  if (!probe.ok) {
    throw new Error(`Tailscale URL probe failed: ${probe.error || probe.status}`);
  }

  const alternates = [];
  if (tailscale.dnsName) {
    alternates.push(`http://${tailscale.dnsName}:${port}${path}`);
  }

  return {
    kind: "tailscale-direct",
    visibility: "tailnet-only",
    primaryUrl,
    alternates,
    probe,
    cleanupCommand: "",
    caveat: "Phone must be connected to the same Tailscale tailnet.",
  };
}

async function tryTailscaleServe({ tailscale, port, path, localHost, timeoutMs }) {
  if (!tailscale.dnsName) {
    throw new Error("Tailscale Serve HTTPS requires a MagicDNS name");
  }

  startTailscaleServe({ tailscale, localHost, port });

  const primaryUrl = `https://${tailscale.dnsName}${path}`;
  const probe = await probeUrl(primaryUrl, timeoutMs);
  if (!probe.ok) {
    try {
      resetTailscaleServe(tailscale.command);
    } catch {
      // Best-effort cleanup only; report the original verification error.
    }
    throw new Error(`Tailscale Serve URL probe failed: ${probe.error || probe.status}`);
  }

  return {
    kind: "tailscale-serve",
    visibility: "tailnet-only",
    primaryUrl,
    alternates: [],
    probe,
    cleanupCommand: `${JSON.stringify(tailscale.command)} serve reset`,
    caveat: "Tailscale Serve config was created and persists until reset.",
  };
}

async function tryNgrok({ port, path, timeoutMs }) {
  const tunnel = await getOrCreateNgrokTunnel(port, { namePrefix: "mobile-url" });
  const primaryUrl = `${tunnel.publicUrl}${path}`;
  const probe = await probeUrl(primaryUrl, timeoutMs);
  if (!probe.ok) {
    throw new Error(`ngrok URL probe failed: ${probe.error || probe.status}`);
  }

  return {
    kind: "ngrok",
    visibility: "public",
    primaryUrl,
    alternates: [],
    probe,
    cleanupCommand: tunnel.created && tunnel.uri ? `curl -X DELETE http://127.0.0.1:4040${tunnel.uri}` : "",
    caveat: "This URL is public and may show an ngrok browser warning on mobile.",
  };
}

function printHuman(result) {
  console.log("");
  console.log("Mobile URL is ready.");
  console.log(`Primary URL: ${result.primaryUrl}`);
  console.log(`Access: ${result.kind}`);
  console.log(`Visibility: ${result.visibility}`);
  for (const alternate of result.alternates || []) {
    console.log(`Alternate URL: ${alternate}`);
  }
  console.log(`Local target: ${result.localTarget}`);
  console.log(
    `Local probe: ${formatProbe(result.localProbe)}${result.localProbe.ok ? "" : " (warning)"}`,
  );
  console.log(`Mobile probe: ${formatProbe(result.mobileProbe)}`);
  if (result.fallbackReason) {
    console.log(`Fallback reason: ${result.fallbackReason}`);
  }
  if (result.cleanupCommand) {
    console.log(`Cleanup: ${result.cleanupCommand}`);
  }
  console.log(`Caveat: ${result.caveat}`);
  console.log("");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const localTarget = `http://${options.localHost}:${options.port}${options.path}`;
  const localProbe = await probeUrl(localTarget, options.timeoutMs);

  let mobile = null;
  let fallbackReason = "";

  if (options.access !== "ngrok") {
    const tailscale = getTailscaleInfo();
    if (tailscale.available) {
      try {
        mobile = options.preferHttps
          ? await tryTailscaleServe({
              tailscale,
              port: options.port,
              path: options.path,
              localHost: options.localHost,
              timeoutMs: options.timeoutMs,
            })
          : await tryTailscaleDirect({
              tailscale,
              port: options.port,
              path: options.path,
              timeoutMs: options.timeoutMs,
            });
      } catch (error) {
        fallbackReason = `Tailscale ${options.preferHttps ? "Serve" : "direct"} failed: ${error.message}`;
        if (!options.preferHttps) {
          try {
            mobile = await tryTailscaleServe({
              tailscale,
              port: options.port,
              path: options.path,
              localHost: options.localHost,
              timeoutMs: options.timeoutMs,
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
    if (options.access === "tailscale") {
      throw new Error(fallbackReason || "Tailscale access was required but unavailable");
    }
    mobile = await tryNgrok({
      port: options.port,
      path: options.path,
      timeoutMs: options.timeoutMs,
    });
  }

  const result = {
    primaryUrl: mobile.primaryUrl,
    access: mobile.kind,
    visibility: mobile.visibility,
    localTarget,
    alternates: mobile.alternates,
    localProbe,
    mobileProbe: mobile.probe,
    fallbackReason,
    cleanupCommand: mobile.cleanupCommand,
    caveat: mobile.caveat,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
