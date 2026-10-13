# Tailscale Access

Use this reference when a mobile preview should be private to the user's tailnet, when checking whether a Tailscale URL is reachable, or when deciding between direct Tailscale HTTP and Tailscale Serve HTTPS.

## CLI Discovery

Prefer the app-bundled CLI on macOS when `tailscale` is not on `PATH`:

```bash
TS="${TS:-$(command -v tailscale 2>/dev/null || true)}"
if [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
"$TS" status
"$TS" ip -4
"$TS" status --json
```

## Direct URL Checks

Check whether the local service is reachable on the Tailscale interface before reporting it:

```bash
lsof -nP -iTCP -sTCP:LISTEN
curl -I --max-time 2 "http://127.0.0.1:<port>/"
curl -I --max-time 2 "http://<tailscale-ip>:<port>/"
```

If the Tailscale IP URL works, use it as the primary URL for the user's own phone. If MagicDNS is enabled, include the MagicDNS URL as an alternate, not the only link.

## Tailscale Serve

Use Tailscale Serve when the user needs HTTPS inside the tailnet or the local server is only usable from loopback:

Use the managed URL helper with `--service <service-id> --https`. It chooses an unused HTTPS port, persists a route receipt, and verifies the exact phone URL. Existing ports and handlers are preserved. The resulting URL includes its HTTPS port and uses the machine's MagicDNS name.

If HTTPS certificates require a consent page, report that blocker. Do not invent a URL or overwrite an existing route. Persistent Serve config alone does not keep the origin alive: it must belong to a managed service whose original expiry remains in force.

Cleanup goes through `mobile-service.mjs stop <service-id>`. It compares the exact endpoint handler with its receipt before running the scoped `tailscale serve --https=<owned-port> off`. Changed ownership is retained as a cleanup failure. Never run global `tailscale serve reset` to close one preview.

Funnel is public; use it only when public access is explicitly required and equivalent managed lifetime/cleanup is available. Serve remains tailnet-only.

## Direct vs Relay

If `tailscale status` shows a peer as `direct`, the phone and machine are not using DERP relay for that connection. If it shows `relay`, `DERP`, or the phone is offline, report that caveat.

Mobile latency can still be higher than desktop-local latency even for a direct connection. A nearby DERP region only helps relay paths; it does not improve an already-direct peer-to-peer path much.

## VPN Slot Caveat

On mobile, Tailscale occupies the system VPN slot. If the phone normally uses a separate VPN or proxy, enabling Tailscale may disable that VPN. For the user's own phone this may still be worth it for private previews; for external callbacks or public sharing, use ngrok fallback instead.
