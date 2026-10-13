# ngrok Fallback

Use this reference when Tailscale is unavailable or insufficient for a mobile preview.

## When To Use ngrok

Use ngrok when any of these are true:

- The recipient is not in the user's tailnet.
- The user explicitly asks for ngrok or a public URL.
- A webhook, OAuth callback, external API provider, or third-party service must reach the local server.
- Tailscale is unavailable, not installed, offline, blocked, or cannot be enabled on the phone because of VPN-slot conflicts.
- Tailscale direct access works, but the specific task requires a public HTTPS endpoint rather than tailnet-only access.

Do not use ngrok as the default for the user's own phone when Tailscale is available.

## Managed Workflow

1. Build the app and start its production server with `mobile-service.mjs start`; retain its origin service ID. Do not deliver an unmanaged dev-server URL.
2. Request the URL; the helper starts an exclusive, managed ngrok agent on free port 4040. It never adopts or stops an existing agent. If 4040 is occupied, report the conflict and arrange an authorized migration or equivalent isolated supervised configuration.

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs <port> --service <origin-service-id> --access ngrok
```

The agent launches its tunnel as part of its foreground command, persists the first HTTPS URL, and pins that URL on restart. It must never replace a delivered URL silently. Confirm origin, agent and public URL readiness before delivery. Report public visibility, origin service ID and exact expiry. Explicit user completion or origin expiry stops only the origin and its exclusive agent; other services and source files remain. The agent also has its own fixed seven-day expiry as a backstop.

If ngrok is absent, needs authentication, or cannot resume the same URL, report the concrete blocker. Never put authentication tokens in service command arguments, receipts or logs; use ngrok's existing protected configuration. An API-created temporary tunnel under `ngrok start --none` is insufficient: it disappears when the agent restarts.

## Markdown Preview Fallback

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory> --access ngrok
```

The helper manages both the Markdown origin and the exclusive ngrok agent. Do not fall back to foreground `markserv`/`ngrok http` commands when it fails; use equivalent supervised hosting or report the blocker.

Choose the served root so Markdown image paths keep working. For example, if `docs/design/note.md` contains `![x](./note/01.png)`, serving the repository root and opening `/docs/design/note.md` should keep the image URL valid.

Validation for Markdown previews:

- Check the local Markdown page returns `200` and `content-type: text/html`.
- If images are present, check at least one local image returns `200`.
- Check the ngrok public page returns `200`; include `ngrok-skip-browser-warning: 1` in scripted validation requests.
- If image validation fails but the page renders, still give the page URL and mention that image paths or the served root may need adjustment.

## Mobile Interaction Validation Over ngrok

When validating interactions through ngrok:

1. Check whether the user is still on ngrok's warning page and needs to tap `Visit Site`.
2. Test the same control on localhost to distinguish app code from tunnel/runtime behavior.
3. Test the public ngrok URL itself, preferably with a mobile viewport.
4. If localhost works but a dev-server tunnel does not, prepare an owned, managed production preview and validate its new URL; retain any previously delivered link until explicit completion or expiry.
5. Report whether the issue was an app bug or a preview-runtime false negative.

Development runtimes can add HMR, overlay, websocket, or bundler clients that behave differently through ngrok than they do on localhost. A Next.js `next dev` tunnel can render the page while public-url interaction state fails to update.

## ngrok EOF / IPv6 Workaround

If ngrok starts its local web interface but the local tunnel API stays empty, inspect ngrok logs before reporting a public URL. A repeated log line like `failed to send authentication request: EOF` often means the agent can resolve and open TCP connections, but the network is breaking TLS or certificate-revocation checks.

Check whether IPv6 is the bad path and IPv4 is healthy:

```bash
curl -Iv --max-time 10 https://api.ngrok.com/
curl -4 -Iv --max-time 10 https://api.ngrok.com/
curl -Iv --max-time 10 http://crl.ngrok-agent.com/ngrok.crl
curl -4 -Iv --max-time 10 http://crl.ngrok-agent.com/ngrok.crl
ngrok diagnose --region jp
ngrok diagnose --ipv6 --region jp
```

If the IPv6/default checks fail with EOF, empty reply, or TLS errors while the IPv4 checks succeed, use a temporary IPv4-only workaround. On macOS Wi-Fi:

```bash
networksetup -setv6off Wi-Fi
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs <port> --service <origin-service-id> --access ngrok
```

Then verify the tunnel exists before giving the URL:

```bash
curl --silent http://127.0.0.1:4040/api/tunnels
```

Treat this as a temporary workaround. Tell the user that ngrok is working because Wi-Fi IPv6 is disabled, and remind them how to restore IPv6 after the mobile preview is done:

```bash
networksetup -setv6automatic Wi-Fi
```

If disabling IPv6 requires admin approval or password input that Codex cannot provide, ask the user to run the command locally and continue once they confirm.

## Reporting ngrok URLs

When an ngrok fallback tunnel is ready, report:

- The public mobile URL.
- The local target it forwards to, such as `localhost:5173`.
- That the URL is public, not tailnet-only.
- Any caveat that matters, such as tunnel lifetime, auth, warning page, HTTPS/callback URL changes, or server restart needs.

Keep desktop localhost URLs secondary and diagnostic only.
