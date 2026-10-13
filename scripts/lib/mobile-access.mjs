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
      env: { ...process.env, TERM: "xterm-256color" }, // Tailscale.app selects CLI mode via TERM.
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

export async function getNgrokTunnels() {
  const response = await fetchWithTimeout("http://127.0.0.1:4040/api/tunnels", {}, 3000);
  if (!response.ok) {
    throw new Error(`ngrok API returned ${response.status}`);
  }
  return response.json();
}
