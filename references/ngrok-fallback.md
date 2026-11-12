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

## Accounts, quota evidence and bounded rotation

All account resources live under `~/.config/on-mobile/`, independently of `CODEX_HOME` and the replaceable skill installation:

| File | Purpose |
|---|---|
| `.env` | Registered authorized identities and paths to protected ngrok configs |
| `ngrok-checks.json` | Latest observations with append-preserved history |
| `ngrok-rotation.json` | Enabled pool in priority order and service/chat grants |
| `rotation-lock/.lockfile` | Kernel-released cross-process rotation lock |

Files are private `0600`; new directories are `0700`. Credentials remain exclusively in owned private ngrok configs, never in these records, command arguments, logs, tests or releases. Do not read tokens into the conversation. `list` is a local inventory/evidence report, **not a live quota API**. It also lists managed agents, but does not establish ownership of unmanaged processes.

The inventory retains its existing literal JSON schema (no shell evaluation):

```dotenv
ON_MOBILE_NGROK_ACCOUNTS='[{"id":"personal","name":"Example","email":"owner@example.invalid","configPath":"/absolute/private/ngrok.yml","domain":"https://example.invalid","history":"Past observation only; current quota unknown"}]'
```

Use an empty domain when unknown. Register only completed accounts with a distinct protected config; pending signup is not a registered/available account. Keep unfinished registrations outside this usable pool until the user-requested registration is actually complete. Do not auto-create accounts or bypass membership/verification restrictions.

### Recording quota

Check the actual account identity, domain, usage and active sessions in its dashboard before recording `available`. Official ordinary tunnel documentation points to the dashboard; no verified public monthly-quota API adapter is implemented. Do not substitute tunnel metrics or the separate AI Gateway API for account monthly allowance. If an official quota interface becomes available, verify its identity and reset semantics before adding an adapter.

```bash
bun <skill>/scripts/mobile-ngrok-accounts.mjs list
bun <skill>/scripts/mobile-ngrok-accounts.mjs check ACCOUNT_ID --identity ACCOUNT_EMAIL --quota available --source dashboard --used-bytes 1000 --limit-bytes 1000000000
```

Only include numerical usage/limits actually shown. Omitted fields remain null. Additional optional flags:

| Flag / field | Meaning |
|---|---|
| `--checked-at ISO` / `checkedAt` | Actual observation time, defaults to now; cannot be in the future |
| `recordedAt` | Time this observation was written, distinct from the observation itself |
| `--cycle-start ISO`, `--cycle-end ISO` | Observed billing period, not an inferred allowance |
| `--provider-reset-at ISO` | Exact provider-confirmed reset instant, with timezone |
| `--estimated-reset-at ISO` | Explicitly estimated reset instant, never confirmation |
| `estimatedResetDate` | Next month first day from observation, date-only; exact reset time/timezone unverified |
| `restoredAt` | First confirmed recovery in the latest exhaustion/recovery cycle; later checks retain it |
| `source`, `errorCode`, `configHash`, `history` | Auditable source, classified provider error, exact bound config and previous observations |

ngrok's pricing page says usage refreshes on the first of each month; the free-plan page describes monthly billing cycles. Use next month first day as an estimate when account-specific reset details are unavailable, not a guaranteed midnight in the user's timezone. Reaching either provider/estimated reset time means **recheck due**, never automatic `available`.

A fresh `available` observation is accepted for 30 minutes only, bound to exact email and config bytes. Stale evidence is displayed as current `unknown` with the historical observation retained. `unknown`/`exhausted` never qualify. `user-report` can record unknown/exhausted historical handoffs but cannot establish available. `provider-error` accepts only `ERR_NGROK_725` with exhausted status. Other errors—including auth, registration, concurrency, network and ordinary HTTP 403—must not be classified as monthly exhaustion. Success of a small URL probe does not establish remaining monthly quota. Automated probes classify only the reserved `ngrok-error-code` response header, never an error-code string in application content. Subsequent error observations retain still-future confirmed reset/cycle metadata and its original evidence time/source.

### Enabling automatic mode

User authorization to automatically choose from a named pool is sufficient for repeated switches within that pool and service; do not demand fresh confirmation for each switch. Default is off. Configure and inspect it with:

```bash
bun <skill>/scripts/mobile-ngrok-accounts.mjs rotation on --accounts primary,backup
bun <skill>/scripts/mobile-ngrok-accounts.mjs rotation status
bun <skill>/scripts/mobile-ngrok-accounts.mjs candidates
bun <skill>/scripts/mobile-ngrok-accounts.mjs authorize ORIGIN_ID
bun <skill>/scripts/mobile-url-for-port.mjs PORT --service ORIGIN_ID --access ngrok --ngrok-auto --json
bun <skill>/scripts/mobile-ngrok-accounts.mjs rotation off
```

`authorize` binds one running origin and its unchanged expiry to the current `CODEX_THREAD_ID`; new services also record their originating chat. Never authorize a service merely because it belongs to the same OS user. For a legacy service lacking a chat owner, establish ownership from its existing delivery evidence first. Do not enroll other chats' origins. A background Markdown resume preserves its saved account and URL; it does not switch accounts without this chat-bound invocation.

This mode runs **when the URL helper is invoked**. It does not install a watcher, poll all accounts, log into dashboards, or promise failover after the invocation finishes. It retains a healthy current route. On a new route it chooses the first eligible pool account; on an owned route with confirmed 725 it records exhaustion and chooses another fresh verified candidate. Unknown, stale, exhausted, reset-due, changed-config and missing accounts are skipped. Every candidate is attempted at most once, in configured priority order. A non-quota failure stops immediately; an empty eligible pool leaves the existing route untouched. `rotation off` prevents subsequent automatic runs and leaves current services running.

Service locks protect ownership and the global rotation lock serializes ngrok creation/switching across chats, including manual operations. Lock acquisition times out after ten seconds; kernel ownership ends on process exit. Port 4040 remains exclusive. Never kill its unrelated listener to free it.

### Manual switching and failure recovery

Manual selection remains supported:

```bash
bun <skill>/scripts/mobile-url-for-port.mjs PORT --service ORIGIN_ID --access ngrok --ngrok-account ACCOUNT_ID --json
bun <skill>/scripts/mobile-url-for-port.mjs PORT --service ORIGIN_ID --access ngrok --ngrok-account NEW_ID --switch-ngrok-from OLD_ID --json
```

The wrapper uses exactly the bound protected `--config`, removes `NGROK_*` environment overrides, and tests reconnect to its pinned account domain before readiness. The account's domain can differ from the old account's domain. Report actual old/new URLs, `urlChanged`, origin and agent IDs, unchanged expiry, and quota evidence freshness. Never say the address stayed the same without comparing it.

Before stopping an agent, verify its exact origin argv, listener, binding and receipt. Replacement inherits the original deadline; the origin is not restarted. Automatic transactions retain `ngrok-rotation-UUID.json` in the external service directory: old route, candidates skipped/attempted, probes, replacement IDs/URLs, expiry and success/failure. Explicit switches retain `ngrok-switch.json`. No raw provider response bodies are logged.

A failed replacement can leave the old agent closed and a partial/new agent running. The audit says `restored: false`; this is not successful rollback. Keep all receipts and report the interruption. Inspect current route and actual agent/listener ownership; clean up only the partial agent using the scoped route cleanup, then explicitly select the recovered original or another freshly verified account. For a closed original account, this creates a new owned agent with the original expiry and pinned configured domain; verify the actual old URL was recovered before reporting restoration. Do not restore an exhausted account automatically, retry an ambiguous partial bootstrap, or resume a transaction after a process crash without examining its evidence.

`ERR_NGROK_4013` blocks new account creation when already a member of a free account. Stop at that provider restriction; do not fabricate identities, automate registration pools or defeat verification. Authorized management of existing accounts does not imply permission to evade provider enforcement.

### Installation and upgrade preservation

Back up the old installation outside skill discovery. Migrate legacy data with the new helper before replacement:

```bash
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs migrate --from /absolute/old-skill/.env
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs migrate-checks --from /absolute/old-skill/.local/ngrok-checks.json
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs location
```

Inventory migration is atomic/no-overwrite; divergent destinations require review. Check migration retains source, original observation time and any newer destination record; it never turns old checks fresh. Reinstallation must not initialize, overwrite or remove the external inventory, quota history, rotation grants, mode preference or service runtime receipts. Tests replace an isolated whole skill tree and change `CODEX_HOME` to verify preservation.

Publish only an authorized immutable release, excluding `.env*`, `.local/`, generated UI metadata, personal accounts, tokens and Git storage. Install the verified downloaded package, retain rollback backup, regenerate mode UI with `mobile-mode.mjs get`, and verify external state bytes are unchanged. Never copy account records back into the skill tree or replace protected ngrok configs.

Official references: [reserved provider error header](https://ngrok.com/docs/gateway/endpoints/http), [725 monthly exhaustion](https://ngrok.com/docs/errors/err_ngrok_725), [4013 account restriction](https://ngrok.com/docs/errors/err_ngrok_4013), [usage refresh](https://ngrok.com/docs/pricing-limits), [free-plan limits and account-bound domain](https://ngrok.com/docs/pricing-limits/free-plan-limits), [public API reference](https://ngrok.com/docs/api-reference).

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
