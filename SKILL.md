---
name: on-mobile
description: Use when the user is on a phone/mobile device, explicitly invokes $on-mobile, asks to preview or test a localhost app/API/dev server/callback/webhook/Markdown file from mobile, or needs a local URL that works outside the development machine. Prefer private Tailscale links for the user's own mobile devices; use ngrok only as fallback when Tailscale is unavailable, insufficient, or public internet access is required.
---

# On Mobile

## Default Rule

When the user is on mobile, assume `localhost`, `127.0.0.1`, and `::1` refer to the phone, not the development machine.

Do not present a desktop localhost URL as the primary mobile link. Use it only as a diagnostic local target.

## Mobile Preview Mode

Use the mode helper when the user asks to turn mobile preview behavior on, off, or automatic:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-mode.mjs get
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-mode.mjs set always
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-mode.mjs set auto
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-mode.mjs set off
```

Modes:

| Mode | Behavior |
|---|---|
| `off` | Do not proactively use this skill unless the user explicitly asks for mobile access. |
| `auto` | Use this skill for strong local-link, preview, callback, webhook, or mobile signals. |
| `always` | Default to this skill for openable local services, local previews, and Markdown documents intended for reading. |

If the mode file is missing or invalid, treat the mode as `auto`.

The helper stores mode state inside this skill's gitignored `.local/` directory and renders `agents/openai.yaml` from `agents/openai.yaml.template` so the Codex UI metadata can show the current mode without making `SKILL.md` dirty. Do not hand-edit the generated `agents/openai.yaml`.

Generated UI metadata uses an emoji badge such as `📱 auto`, `🟢 always`, or `⚪ off` so the mobile skill chip is easier to scan. Codex App may cache skill metadata; if the chip still shows the old mode, tell the user to restart or reload Codex App.

## Decision Chain

1. Identify the target: local port, dev server URL, API callback, webhook endpoint, or Markdown/file preview.
2. If the target is an existing local port, prefer `scripts/mobile-url-for-port.mjs`.
3. If the target is a Markdown file or directory, prefer `scripts/serve-markdown-mobile.mjs`.
4. If the user's own phone or tablet is in the tailnet, prefer Tailscale direct HTTP: `http://<tailscale-ip>:<port>/<path>`.
5. If HTTPS is required inside the tailnet, or the local service is loopback-only, use Tailscale Serve.
6. If the recipient is not in the user's tailnet, or an external service must call back to the local machine, use ngrok fallback.
7. If the user needs to judge mobile interactions, verify the final mobile URL itself, not only localhost.
8. All delivered mobile links must use a system-managed service and the lifecycle below, including existing ports, Markdown, videos, and tunnels. A foreground tool session is not durable hosting.

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

## Durable Link Lifetime

Use `scripts/mobile-service.mjs` on macOS: launchd owns the server independently of the task, restarts failures within the original lifetime, and reclaims it at expiry. Keep each link until the user explicitly says they are done or asks to close it, or seven days from service creation, whichever comes first. Viewing, playback completion, inactivity, agent completion, and task archival are not user confirmation. Never renew the deadline merely by probing, restarting, or reopening a task.

Manage the origin **and** any tunnel agent. `nohup`, shell `&`, a live tool session, and persistent proxy configuration alone do not meet this requirement. For another OS/host, use an equivalent system supervisor or hosted service with explicit expiry and scoped cleanup; if unavailable, report the blocker instead of delivering a temporary URL as durable. Local hosting still needs the Mac awake, online, and logged in; after sleep/logout, enforce the original deadline before serving again.

Start an existing app's production server under management before obtaining its URL (use its actual command, absolute work directory, and free port):

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-service.mjs start --cwd /absolute/project --port 3215 -- bun run start -- --port 3215 --hostname 0.0.0.0
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-service.mjs status <service-id>
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-service.mjs list
```

The server command must remain in the foreground as launchd’s child; do not pass a command that forks away or daemonizes itself. Use stable installed executables and files that launchd can read. macOS may block background access to protected folders such as Documents; if readiness fails there, stage the intended preview files and required assets in a durable task-owned directory under `~/.codex/mobile-previews/`, preserving relative paths, then probe again. Do not claim readiness from a PID alone.

Do not take over or stop an unrelated listener. Prepare a task-owned service on a free port, or first arrange an authorized migration. Receipt IDs are returned by `start`; do not invent them. State, logs and cleanup receipts live under `${CODEX_HOME:-$HOME/.codex}/state/on-mobile/services/`. Only `running` plus a successful origin/URL probe permits delivery. The URL helper verifies the listening process belongs to the managed child tree.

When the user confirms completion, run `mobile-service.mjs stop <service-id>` and check `status` until `closed`; `stopping` and `cleanup_failed` are not completed cleanup. Expiry is enforced by the worker without an active Codex turn; missed deadlines are enforced on resume. Stop only owned service jobs and exact owned routes, never shared Tailscale/ngrok daemons or other routes. Keep source/delivery files and failed-cleanup evidence. Report the service ID, exact expiry and completion command with the link. Do not schedule a chat reminder as a substitute for service expiry.

## Recover Existing Deliveries

For broken links, missing media, deleted worktrees, endpoint limits, or reuse of a shared public entry, read [delivery recovery](references/delivery-recovery.md). Inventory before changing anything; a page returning 200 does not prove its video or images exist. Use the original service deadline when restoring (`start ... --inherit ORIGINAL_ID`), never a fresh seven days. Preserve active routes and shared transports. Reuse only ownership-verified supported gateways; distinguish current reachability from proven restart behavior. If the same URL cannot be recovered, disclose the failure and any proposed replacement before presenting it as the original.

Use `mobile-delivery.mjs` for configurable allowlisted static files, galleries, link indexes and owned gateway subpaths; use `mobile-links.mjs` for read-only file/media/transport audits. Keep task paths, URLs, service IDs and receipts outside the skill repository. Bun is an installed dependency, not a bundled binary; retain its genuine developer signature.

## Existing Port Helper

For a managed local app, API, dashboard, or production server on a known port, run:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs <port> --service <service-id> --path /
```

Useful modes:

```bash
# Default: Tailscale first, ngrok fallback.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --service <service-id> --path /cards

# Require Tailscale and fail instead of using ngrok.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --service <service-id> --path /cards --access tailscale

# Force public ngrok fallback.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --service <service-id> --path /cards --access ngrok

# Prefer Tailscale Serve HTTPS. This creates an owned HTTPS port without replacing shared Serve config.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs 3215 --service <service-id> --path /cards --https
```

Read `references/tailscale-access.md` before manually rebuilding Tailscale checks, Serve setup, MagicDNS caveats, or direct/relay diagnostics.

## Markdown Preview Helper

For rendered Markdown on mobile, run:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory>
```

The helper serves the right root for relative images, verifies local HTML, prefers Tailscale, falls back to ngrok when allowed, and prints the mobile URL.

The helper starts a managed launchd service, verifies the page and returns its URL, service ID and expiry; the calling command can exit. Markserv must have a stable installed entrypoint, not a temporary package-cache executable. Read the reference for setup. Keep the service until explicit user completion or its fixed seven-day deadline.

Useful modes:

```bash
# Require Tailscale and fail instead of falling back to ngrok.
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs ./README.md --access tailscale

# Force managed ngrok fallback.
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

When the user needs to preview or validate an app on mobile, build it first, serve the production build, and verify the exact URL the phone will open. This includes visual review, taps, forms, selects, dialogs, drag handles, auth callbacks, websocket behavior, recipe viewers, menus, and any other client-side interaction.

For Next.js apps, build and start the production server before reporting the mobile URL:

```bash
bun run build
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-service.mjs start --cwd /absolute/project --port <port> -- bun run start -- --port <port> --hostname 0.0.0.0
```

Development runtimes add HMR, overlays, websocket clients, and bundler behavior that can differ through Tailscale, Tailscale Serve, or ngrok. Do not use a development server as the reported mobile preview for interactive app checks; it can render the page while interaction state fails to update.

If a mobile preview is visible but controls do not respond:

1. Test the same control on localhost.
2. Test the mobile URL itself, preferably with a mobile viewport.
3. Check whether the issue is app code, preview runtime, Tailscale reachability, or ngrok warning/tunnel behavior.

Read `references/mobile-interaction-validation.md` for the fuller checklist and framework-specific preview guidance.

## Reporting

When the mobile URL is ready, report:

- The primary mobile URL, preferably Tailscale for the user's own phone.
- If a URL is formatted as a Markdown link, the link target must be the same complete openable URL shown in the label. Never use `/`, `#`, an empty target, or a local file path as the target for a URL-looking label.
- Whether the URL is tailnet-only or public.
- The local target it reaches, such as `localhost:5173`.
- Whether HTTPS is provided by Tailscale Serve, the app server, or ngrok fallback.
- Any caveat that matters: phone Tailscale status, MagicDNS dependency, VPN-slot conflicts, tunnel lifetime, auth, callback URL changes, warning pages, or server restart needs.
- For Markdown previews, the stable installed Markserv entrypoint.
- Managed service ID, creation time, exact expiry (at most seven days), and the command to run after explicit user completion. Do not stop at task completion.

Keep desktop localhost URLs secondary and diagnostic only.
