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

## Workflow

1. Identify the local port from the dev server output, configuration, or port scan.
2. Start the local server if the task requires a running preview.
   - If the user needs to judge mobile interaction behavior, prefer a production preview over a development server when the project supports it. For Next.js projects, prefer `bun run build` followed by `bun run start -- -p <port> --hostname 0.0.0.0` before opening the tunnel.
   - Use dev-server tunnels for quick visual previews only unless interaction has also been verified through the public URL.
3. Check whether an ngrok tunnel for that port already exists.
4. If no suitable tunnel exists, start one with `ngrok http <port>`.
5. If ngrok starts but no public tunnel appears, diagnose ngrok before falling back to a LAN URL.
6. Read the forwarding URL from ngrok output or the local ngrok API at `http://127.0.0.1:4040/api/tunnels`.
7. Give the user the `https://...ngrok...` URL and mention the local port it forwards to.

## Commands

Prefer commands that preserve the existing project tooling. For JavaScript and TypeScript projects, prefer Bun commands when starting the app.

Useful checks:

```bash
ngrok http <port>
curl --silent http://127.0.0.1:4040/api/tunnels
```

If `ngrok` is missing, tell the user and ask whether to install or configure it. If ngrok requires auth, report the exact blocker and avoid inventing a public URL.

## Markdown Preview Fallback

The helper script can force the old ngrok behavior:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory> --access ngrok
```

If the helper script is unavailable, manually serve Markdown with Markserv and expose that port through ngrok:

```bash
markserv <serve-root> -p <port> -a 0.0.0.0 --browser false --livereloadport false
ngrok http <port>
```

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
4. If localhost works but a dev-server tunnel does not, restart as a production preview and create a fresh tunnel.
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
ngrok start <name>
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
