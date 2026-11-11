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
2. Complete the account checks below and pass `--ngrok-account ACCOUNT_ID`. Request the URL; the helper starts an exclusive, managed ngrok agent on free port 4040. It never adopts or stops an existing agent. If 4040 is occupied, report the conflict and arrange an authorized migration or equivalent isolated supervised configuration.

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs <port> --service <origin-service-id> --access ngrok --ngrok-account <account-id>
```

The agent launches its tunnel as part of its foreground command, persists the first HTTPS URL, and pins that URL on restart. It must never replace a delivered URL silently. Confirm origin, agent and public URL readiness before delivery. Report public visibility, origin service ID and exact expiry. Explicit user completion or origin expiry stops only the origin and its exclusive agent; other services and source files remain. The agent also has its own fixed seven-day expiry as a backstop.

If ngrok is absent, needs authentication, or cannot resume the same URL, report the concrete blocker. Never put authentication tokens in service command arguments, receipts or logs; use ngrok's existing protected configuration. An API-created temporary tunnel under `ngrok start --none` is insufficient: it disappears when the agent restarts.

## Local Account Inventory and Explicit Switching

Account resources belong in the fixed `~/.config/on-mobile/.env` (mode `0600`, newly created parent directory `0700`), never in public skill text, tests or release payloads. Use one literal JSON assignment; the helper does not source shell code or interpolate variables:

```dotenv
ON_MOBILE_NGROK_ACCOUNTS='[{"id":"personal","name":"Example","email":"owner@example.invalid","configPath":"/absolute/private/ngrok.yml","domain":"https://example.invalid","history":"Past observations only; current quota unknown"}]'
```

Use an empty `domain` when unknown. This path is independent of the skill checkout, installation directory and `CODEX_HOME`. `mobile-ngrok-accounts.mjs location` prints it without showing account details. Missing external inventory is an error; reads never fall back to a stale in-tree `.env`. Each account needs its own absolute configuration path (no comma-separated config merge). Never copy authtokens or API keys into this file. Existing ngrok config files remain untouched and must be owned regular files with private permissions. The helper suppresses provider stdout/stderr and rejects changed configurations before restart; inspect provider diagnostics locally without pasting secrets if readiness fails.

1. Run `bun <skill>/scripts/mobile-ngrok-accounts.mjs list`. It shows local identities, historical notes, recorded checks, and live managed-agent ownership. It does not query live provider quota or claim unmanaged agents belong to this skill.
2. In the selected account’s dashboard, verify the email/account, its domain, current usage and available quota, and active agent sessions. Inspect local listeners too. Do not infer identity from a filename, a working URL, or the token’s shape. A past limit error is historical; quotas can reset. Unknown/exhausted quota stops new creation or switching; investigate or use the provider’s legitimate upgrade/reset process, never automatic account rotation.
3. After actually observing that dashboard, record it:

```bash
bun <skill>/scripts/mobile-ngrok-accounts.mjs check ACCOUNT_ID --identity ACCOUNT_EMAIL --quota available --source dashboard
```

`unknown` and `exhausted` can also be recorded but do not authorize use. The record binds the exact configuration bytes to the identity and expires after 30 minutes. It is a local observation, not a live quota API. Never fabricate an available check to make a command pass. Restarts of an already owned agent preserve the binding and original deadline without requiring a new manual check on each restart. A managed Markdown origin also resumes its persisted route after restart; after an explicit switch, that route’s current binding takes precedence over the original account argument. This internal resume path requires the actual managed Markdown parent process and still verifies the binding/configuration, listener ownership and pinned URL.

4. For a new tunnel, choose the account explicitly:

```bash
bun <skill>/scripts/mobile-url-for-port.mjs PORT --service ORIGIN_ID --access ngrok --ngrok-account ACCOUNT_ID --json
```

The wrapper passes exactly that `--config`, strips `NGROK_*` environment overrides, pins the account’s domain (or first acquired URL), verifies ownership and reconnects to the same URL before reporting ready. No default configuration is overwritten. Port 4040 remains exclusive; an unrelated listener is a blocker, never a reason to kill another process.

5. To change an existing tunnel, first show the user the origin ID, old/new identities, current quota observations, old URL and expected new domain (or unknown), original expiry and likely brief interruption. Only after the user explicitly selects the change:

```bash
bun <skill>/scripts/mobile-url-for-port.mjs PORT --service ORIGIN_ID --access ngrok --ngrok-account NEW_ID --switch-ngrok-from OLD_ID --json
```

The helper verifies the exact old agent/receipt/listener, records the switch intent, stops only that agent, and starts a replacement inheriting the origin’s original deadline. It leaves the origin and other services running. Legacy receipts are identified as `legacy-unverified`; migrating one requires that exact source ID plus manual dashboard ownership checks. A mismatched account, unrelated route, inactive origin, stale quota check or occupied API port must not trigger a broader cleanup.

Report `accountSwitch.oldUrl`, `newUrl`, `urlChanged`, origin ID and unchanged expiry. If replacement fails, report the interruption; retain `ngrok-switch.json`, route and agent receipts for inspection. Do not claim success, rotate accounts, or silently restore another identity. A partial new agent can be inspected and completed with the normal URL command after fresh checks, or explicitly cleaned up; do not blindly rerun a switch against the old account.

### Installation and upgrade preservation

The external `~/.config/on-mobile/.env` is user-owned configuration, not part of any skill payload. Upgrading or reinstalling the skill replaces only the selected skill tree; never initialize, overwrite, restore over, or delete this external file as an installation step. Deleting the external configuration or the whole home directory is outside this guarantee. Keep a separate private backup for recovery.

For a legacy in-tree inventory, first back up the old installation outside skill discovery and then run the new helper:

```bash
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs migrate --from /absolute/old-skill/.env
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs location
```

Migration validates the source, atomically creates the fixed external file without overwriting, verifies exact bytes and enforces private permissions. An identical destination is accepted unchanged; a different destination, link or insecure file is rejected with both copies retained. It prints only the destination, account count and migration status, never account values. The source stays intact for rollback. After the new installed helper successfully reads the external inventory and you verify its bytes against the backup, remove legacy in-tree copies; do not merge divergent copies or silently prefer one.

Publish from an explicit committed version: packages exclude `.env*`, `.local/`, generated `agents/openai.yaml` and all Git storage. Scan for real account identifiers and credentials before publication. Download and verify the published release, then replace only the skill installation. Preserve `.local/` and regenerate mode UI metadata with `mobile-mode.mjs get`; quota observations in `.local/` remain time-limited observations, not current provider data. Verify payload files separately from restored mode state, and verify the external inventory's bytes and permissions remain unchanged. Do not copy the external `.env` back into the installation or publish it as a release asset. Never replace protected ngrok configuration files.

A reinstall regression test must remove/recreate an isolated entire skill directory and show that the same external account inventory is still read, even if a stale `.env` appears in that new skill directory or `CODEX_HOME` changes.

Official references: [agent configuration and environment precedence](https://ngrok.com/docs/gateway/agent/config/), [current usage](https://dashboard.ngrok.com/usage), [free-plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits/).

## Markdown Preview Fallback

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory> --access ngrok --ngrok-account <account-id>
```

Pass `--ngrok-account` after completing the same dashboard checks. For an existing preview, use its original service ID with the URL helper’s explicit switch command; do not create a second origin or renew its deadline.

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
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/mobile-url-for-port.mjs <port> --service <origin-service-id> --access ngrok --ngrok-account <account-id>
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
