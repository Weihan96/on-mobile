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

```bash
TS="${TS:-$(command -v tailscale 2>/dev/null || true)}"
if [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
"$TS" serve --bg localhost:<port>
"$TS" serve status
```

The resulting URL uses the machine's MagicDNS name:

```text
https://<machine>.<tailnet>.ts.net/<path>
```

If the tailnet has not enabled HTTPS certificates, `tailscale serve` may send the user to a consent page. Surface that blocker instead of inventing a URL.

Treat Serve config as persistent. Report the cleanup command:

```bash
tailscale serve reset
```

Do not use Tailscale Funnel unless the user explicitly needs a public internet URL. Funnel is public; Serve is tailnet-only.

## Direct vs Relay

If `tailscale status` shows a peer as `direct`, the phone and machine are not using DERP relay for that connection. If it shows `relay`, `DERP`, or the phone is offline, report that caveat.

Mobile latency can still be higher than desktop-local latency even for a direct connection. A nearby DERP region only helps relay paths; it does not improve an already-direct peer-to-peer path much.

## VPN Slot Caveat

On mobile, Tailscale occupies the system VPN slot. If the phone normally uses a separate VPN or proxy, enabling Tailscale may disable that VPN. For the user's own phone this may still be worth it for private previews; for external callbacks or public sharing, use ngrok fallback instead.
