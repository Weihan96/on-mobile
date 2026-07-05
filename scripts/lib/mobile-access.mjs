import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const macosTailscalePath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function commandPath(name) {
  try {
    return execFileSync("zsh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function tailscaleCommandPath() {
  const fromPath = commandPath("tailscale");
  if (fromPath) return fromPath;
  if (existsSync(macosTailscalePath)) return macosTailscalePath;
  return "";
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeUrl(url, timeoutMs = 5000) {
  const startedAt = Date.now();
  try {
    let response = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" }, timeoutMs);
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, timeoutMs);
    }
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url,
      elapsedMs: Date.now() - startedAt,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      finalUrl: "",
      elapsedMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

export function formatProbe(probe) {
  if (!probe) return "not checked";
  if (probe.ok) {
    const type = probe.contentType ? ` ${probe.contentType}` : "";
    return `${probe.status}${type} in ${probe.elapsedMs}ms`;
  }
  return `failed in ${probe.elapsedMs}ms: ${probe.error || probe.status}`;
}

export function normalizeDnsName(value) {
  return (value || "").replace(/\.$/, "");
}

export function getTailscaleInfo() {
  const command = tailscaleCommandPath();
  if (!command) {
    return { available: false, reason: "tailscale CLI not found" };
  }

  let status;
  try {
    const raw = execFileSync(command, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    status = JSON.parse(raw);
  } catch (error) {
    return { available: false, command, reason: `tailscale status failed: ${error.message}` };
  }

  if (status.BackendState !== "Running") {
    return {
      available: false,
      command,
      reason: `tailscale backend is ${status.BackendState || "not running"}`,
    };
  }

  const ips = status.TailscaleIPs || status.Self?.TailscaleIPs || [];
  const ip4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || "";
  const dnsName = normalizeDnsName(status.Self?.DNSName || "");

  if (!ip4) {
    return { available: false, command, reason: "tailscale has no IPv4 address" };
  }

  return {
    available: true,
    command,
    ip4,
    dnsName,
    magicDnsEnabled: Boolean(status.CurrentTailnet?.MagicDNSEnabled),
    tailnet: status.CurrentTailnet?.Name || "",
    hostName: status.Self?.HostName || "",
  };
}

export function getServeStatus(command) {
  try {
    return execFileSync(command, ["serve", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch (error) {
    return `serve status failed: ${error.message}`;
  }
}

export function assertServeCanBeCreated(command) {
  const beforeStatus = getServeStatus(command);
  if (beforeStatus && !beforeStatus.includes("No serve config")) {
    throw new Error("Tailscale Serve already has config; refusing to overwrite it automatically");
  }
}

export function startTailscaleServe({ tailscale, localHost = "localhost", port }) {
  assertServeCanBeCreated(tailscale.command);
  try {
    execFileSync(tailscale.command, ["serve", "--bg", "--yes", `${localHost}:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
  } catch (error) {
    const detail = error.stderr?.toString?.() || error.stdout?.toString?.() || error.message;
    throw new Error(`tailscale serve failed: ${detail.trim()}`);
  }
}

export function resetTailscaleServe(command) {
  execFileSync(command, ["serve", "reset"], { stdio: "ignore", timeout: 5000 });
}

export async function getNgrokTunnels() {
  const response = await fetchWithTimeout("http://127.0.0.1:4040/api/tunnels", {}, 3000);
  if (!response.ok) {
    throw new Error(`ngrok API returned ${response.status}`);
  }
  return response.json();
}

export function tunnelMatchesPort(tunnel, port) {
  const addr = tunnel?.config?.addr || "";
  return addr === `${port}` || addr.endsWith(`:${port}`) || addr === `http://localhost:${port}`;
}

export async function getOrCreateNgrokTunnel(port, { namePrefix = "mobile-url" } = {}) {
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
    return { publicUrl: existing.public_url, created: false, uri: existing.uri || "" };
  }

  const response = await fetchWithTimeout(
    "http://127.0.0.1:4040/api/tunnels",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `${namePrefix}-${port}-${Date.now()}`,
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
  return { publicUrl: tunnel.public_url, uri: tunnel.uri || "", created: true };
}

export async function deleteNgrokTunnel(uri) {
  if (!uri) return;
  await fetchWithTimeout(`http://127.0.0.1:4040${uri}`, { method: "DELETE" }, 3000);
}
