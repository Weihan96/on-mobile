---
name: on-mobile
description: Use when the user explicitly invokes $on-mobile, says they are on a phone/mobile device, asks to preview or test a localhost app or local Markdown file from a mobile device, or needs a local development server or rendered Markdown preview URL that works outside the desktop machine. Requires replacing localhost/127.0.0.1/::1 links with an ngrok public HTTPS URL for mobile access.
---

# On Mobile

## Overview

When working for a user who is on mobile, assume `localhost`, `127.0.0.1`, and `::1` refer to the user's phone, not the development machine. For local web apps, create or reuse an ngrok tunnel and give the user the ngrok HTTPS URL instead of a localhost URL.

For local Markdown files, do not send a raw file path or Codex drawer/source view as the primary answer. Render the Markdown to HTML with a local Markdown server, preserve relative image/assets paths, then expose that server through ngrok.

## Localhost Rule

Use ngrok whenever all of these are true:

- The user is on mobile, explicitly invokes `$on-mobile`, or asks for a phone-accessible preview.
- The app, API, dev server, callback, webhook receiver, or preview is bound to a local port.
- You would otherwise give the user a `localhost`, `127.0.0.1`, or `::1` URL.

Do not present a localhost URL as the primary link for the mobile user. Give the ngrok URL first.

## Workflow

1. Identify the local port from the dev server output, configuration, or port scan.
2. Start the local server if the task requires a running preview.
   - If the user needs to judge mobile interaction behavior, prefer a production preview over a development server when the project supports it. For Next.js projects, prefer `bun run build` followed by `bun run start -- -p <port>` for the mobile ngrok URL.
   - Use `next dev`/dev-server tunnels for quick visual previews only unless interaction has also been verified through the public URL.
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

## Markdown Preview For Mobile

Use this flow when the user is on mobile and wants to read a local `.md` file, README, design note, report, or Markdown artifact with rendered formatting or images.

When composing Markdown directly for a Codex mobile user, do not assume the mobile conversation renderer supports full GitHub-flavored Markdown or arbitrary HTML. Prefer plain tables, normal links, blockquotes, and code blocks. Avoid relying on GitHub callouts, HTML `<details>`, or remote URL Markdown image rendering inside the conversation. Local host file-path images may render when Codex can access the file, but still provide a normal link, artifact, or mobile preview URL when the image is important. For the observed support matrix and safer alternatives, read `references/codex-mobile-markdown-rendering.md`.

Prefer the bundled helper script:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory> --port 8642
```

The script should:

1. Resolve the Markdown target.
2. Serve the git repository root when the target is inside a git repo; otherwise serve the Markdown file's parent directory or the requested directory.
3. Start Markserv bound to `0.0.0.0`.
4. Verify the local rendered Markdown URL returns HTML.
5. Verify at least one local relative image when the rendered HTML contains images.
6. Reuse or create an ngrok HTTPS tunnel for the Markserv port.
7. Verify the public Markdown URL, then report it as the primary mobile link.

Markserv discovery and installation policy:

- First use a stable installed command discovered with `command -v markserv`.
- If no stable `markserv` command exists, use `bunx markserv` only as a temporary fallback for the current preview.
- When the fallback is used, tell the user that repeated use should install Markserv persistently:

```bash
bun add -g markserv
```

- Do not rely on or document Bun's temporary `bunx-*` cache paths as stable Markserv entrypoints.
- Do not automatically run a global install unless the user explicitly asks for persistent installation.

If the helper script is unavailable, use the same behavior manually. A typical stable Markserv command is:

```bash
markserv <serve-root> -p <port> -a 0.0.0.0 --browser false --livereloadport false
```

Choose the served root so Markdown image paths keep working. For example, if `docs/design/note.md` contains `![x](./note/01.png)`, serving the repository root and opening `/docs/design/note.md` should keep the image URL valid.

Validation for Markdown previews:

- Check the local Markdown page returns `200` and `content-type: text/html`.
- If images are present, check at least one local image returns `200`.
- Check the ngrok public page returns `200`; include `ngrok-skip-browser-warning: 1` in scripted validation requests.
- If image validation fails but the page renders, still give the page URL and mention that image paths or the served root may need adjustment.

## Mobile Interaction Validation

When the mobile preview is meant to validate clicks, taps, selects, dropdowns, dialogs, drag handles, or other interactive UI, do not trust a development-server tunnel by default. Development runtimes can add HMR, overlay, websocket, or bundler clients that behave differently through ngrok than they do on localhost. In particular, a Next.js `next dev` tunnel can render the page while public-url interaction state fails to update.

Prefer this shape for interaction checks:

```bash
bun run build
bun run start -- -p <port>
ngrok http <port>
```

Then verify the public HTTPS URL, not just localhost. For controls, check that the state actually changes, such as `aria-checked`, `aria-pressed`, `aria-expanded`, route, dialog open state, or visible result text.

If the user says a mobile preview is visible but controls do not respond:

1. Check whether the user is still on ngrok's warning page and needs to tap `Visit Site`.
2. Test the same control on localhost to distinguish app code from tunnel/runtime behavior.
3. Test the public ngrok URL itself, preferably with a mobile viewport.
4. If localhost works but the dev-server tunnel does not, restart as a production preview and create a fresh tunnel.
5. Report whether the issue was an app bug or a preview-runtime false negative.

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

## Reporting

When the tunnel is ready, report:

- The public mobile URL.
- The local target it forwards to, such as `localhost:5173`.
- Any caveat that matters, such as tunnel lifetime, auth, HTTPS/callback URL changes, or server restart needs.
- For Markdown previews, mention whether Markserv used a persistent install or temporary `bunx` fallback. If `bunx` was used, recommend `bun add -g markserv` for repeated use.

Keep the desktop localhost URL as secondary diagnostic information only when useful.
