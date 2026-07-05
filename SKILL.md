---
name: on-mobile
description: Use when the user is on a phone/mobile device, explicitly invokes $on-mobile, asks to preview or test a localhost app/API/dev server/callback/webhook/Markdown file from mobile, or needs a local URL that works outside the development machine. Prefer private Tailscale links for the user's own mobile devices; use ngrok only as fallback when Tailscale is unavailable, insufficient, or public internet access is required.
---

# On Mobile

## Default Rule

When the user is on mobile, assume `localhost`, `127.0.0.1`, and `::1` refer to the phone, not the development machine.

Do not present a desktop localhost URL as the primary mobile link. Use it only as a diagnostic local target.

## Decision Chain

1. Identify the target: local port, dev server URL, API callback, webhook endpoint, or Markdown/file preview.
2. If the target is an existing local port, prefer `scripts/mobile-url-for-port.mjs`.
3. If the target is a Markdown file or directory, prefer `scripts/serve-markdown-mobile.mjs`.
4. If the user's own phone or tablet is in the tailnet, prefer Tailscale direct HTTP: `http://<tailscale-ip>:<port>/<path>`.
5. If HTTPS is required inside the tailnet, or the local service is loopback-only, use Tailscale Serve.
6. If the recipient is not in the user's tailnet, or an external service must call back to the local machine, use ngrok fallback.
7. If the user needs to judge mobile interactions, verify the final mobile URL itself, not only localhost.
8. If the preview must stay open while the user checks it, keep the server attached to a foreground command session.

Use this routing table:

| Situation | Primary mobile URL |
|---|---|
| User's phone is on the same tailnet and the app listens on a reachable interface | Tailscale direct HTTP |
| MagicDNS is available and the phone resolves tailnet names | Tailscale direct MagicDNS alternate |
| HTTPS is required inside the tailnet | Tailscale Serve HTTPS |
| The service only listens on `127.0.0.1` | Tailscale Serve to the loopback service |
| Recipient is not in the user's tailnet | ngrok fallback |
| Webhook, OAuth callback, or external provider must reach the local server | ngrok fallback |
| Phone cannot keep Tailscale enabled because of VPN-slot conflicts | ngrok fallback or explain the tradeoff |

## Existing Port Helper

For a local app, API, dashboard, or dev server already running on a known port, run:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs <port> --path /
```

Useful modes:

```bash
# Default: Tailscale first, ngrok fallback.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --path /cards

# Require Tailscale and fail instead of using ngrok.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --path /cards --access tailscale

# Force public ngrok fallback.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --path /cards --access ngrok

# Prefer Tailscale Serve HTTPS. This may create persistent Serve config.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --path /cards --https
```

Read `references/tailscale-access.md` before manually rebuilding Tailscale checks, Serve setup, MagicDNS caveats, or direct/relay diagnostics.

## Markdown Preview Helper

For rendered Markdown on mobile, run:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory>
```

The helper serves the right root for relative images, verifies local HTML, prefers Tailscale, falls back to ngrok when allowed, and prints the mobile URL.

Keep the command running in the foreground while the user checks the link. Do not use `nohup ... &`, shell background jobs, or one-shot detached commands for live previews; those processes may be reclaimed after the parent command exits.

Useful modes:

```bash
# Require Tailscale and fail instead of falling back to ngrok.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs ./README.md --access tailscale

# Force old ngrok behavior.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs ./README.md --access ngrok

# Prefer Tailscale Serve HTTPS inside the tailnet.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs ./README.md --https
```

Read `references/markdown-preview.md` for Markserv installation policy, Codex mobile Markdown rendering caveats, image validation, and preview process lifetime details.

## ngrok Fallback

Use ngrok only when Tailscale is unavailable, insufficient, explicitly requested, or the task needs a public internet URL.

Read `references/ngrok-fallback.md` before using ngrok. That reference covers tunnel discovery, warning-page behavior, public URL reporting, interaction validation over ngrok, and the known IPv6/EOF workaround.

Do not use Tailscale Funnel unless the user explicitly needs a public internet URL. Funnel is public; Tailscale Serve is tailnet-only.

## Mobile Interaction Validation

When the user needs to validate taps, forms, selects, dialogs, drag handles, auth callbacks, or other mobile behavior, verify the exact URL the phone will open.

Use dev-server previews for quick visual checks only. Prefer a production preview when the project supports it and the interaction result matters.

If a mobile preview is visible but controls do not respond:

1. Test the same control on localhost.
2. Test the mobile URL itself, preferably with a mobile viewport.
3. Check whether the issue is app code, preview runtime, Tailscale reachability, or ngrok warning/tunnel behavior.

Read `references/mobile-interaction-validation.md` for the fuller checklist and framework-specific preview guidance.

## Reporting

When the mobile URL is ready, report:

- The primary mobile URL, preferably Tailscale for the user's own phone.
- Whether the URL is tailnet-only or public.
- The local target it reaches, such as `localhost:5173`.
- Whether HTTPS is provided by Tailscale Serve, the app server, or ngrok fallback.
- Any caveat that matters: phone Tailscale status, MagicDNS dependency, VPN-slot conflicts, tunnel lifetime, auth, callback URL changes, warning pages, or server restart needs.
- For Markdown previews, whether Markserv used a persistent install or temporary `bunx` fallback.
- Any cleanup command or foreground session id needed to stop the preview.

Keep desktop localhost URLs secondary and diagnostic only.
