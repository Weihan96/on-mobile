# Update an origin without replacing its transport

The user wants a new app version at the same reachable URL. Reuse a healthy, ownership-verified transport; do not ask for dashboard login solely because quota observations have aged. This workflow updates only the app child, never the tunnel, service identity, port, owner, creation time or expiry. Separate small app deployment from large asset/model transfer.

## Prepare and submit

1. Inspect `mobile-service.mjs status ID` and the existing route/agent receipt. Establish that this chat owns the origin. `update` requires the immutable `ownerThreadId` to equal current `CODEX_THREAD_ID`; it does not claim legacy/unowned origins or allow cross-chat updates.
2. Build/download and verify the candidate into a **new immutable release directory**. Keep the active and previous release directories and assets. Do not overwrite an executing release or use update to change credentials, account, public domain or port. A foreground server is required; launchers must not daemonize or leave detached listeners.
3. Choose a cheap local readiness endpoint with a 2xx response. An initial origin defaults to `/` for rollback readiness; use `--previous-ready` when its actual health path differs. The tool probes the current app before queuing; each saved release retains its own health path. Commands must listen on the original port.

```bash
bun <skill>/scripts/mobile-service.mjs update ORIGIN_ID --cwd /absolute/releases/new --ready /health --previous-ready /old-health -- bun server.mjs --port ORIGINAL_PORT
bun <skill>/scripts/mobile-service.mjs status ORIGIN_ID
```

Submission returns `queued` and an `updateId`, not a successful deployment. Poll status for the matching `updateResult.id`:

- `ready`: candidate child passed local readiness; verify the public URL/version below.
- `rolled-back`: candidate failed; the previous app passed its own readiness check and the complete previous deployment/rollback record was restored. Report the failed upgrade, not success.
- `rejected`: stale/foreign request or pre-maintenance failure; this request did not stop the existing app.
- `recovered-commit`: the candidate commit survived a worker interruption; the worker selected that candidate, not the original version. Verify readiness and version before delivery.
- `aborted`: stop/expiry interrupted the transaction; lifecycle cleanup takes precedence.
- `rollback-failed` or `update-failed`: inspect receipts and actual readiness; do not claim recovery. The worker may restart the committed release within the unchanged TTL, but that is not proof of recovery.

The worker serializes update work under the same origin resource lock used for route operations. A second pending update is rejected. Lock contention may return a retryable error; it is not permission to stop other jobs.

## Maintenance and rollback

Before stopping its own app child, the supervisor publishes a worker-bound maintenance window of at most 60 seconds and no later than the original expiry. Only an ownership-verified ngrok wrapper supporting this protocol tolerates the temporary origin downtime; it keeps its existing connection and pinned URL. Health checks, retries, sleep, process restarts and updates never renew expiry.

The candidate gets at most the first 25 seconds, with time reserved for restoring the old app. The tool terminates only its owned child handle, never an arbitrary PID or port listener. Readiness verifies that the listener is the new managed child or descendant. A candidate failure starts the previous immutable command and probes its previous path. A successful candidate atomically commits `deployment.json` only after readiness. Failed attempts retain `update-request.json`, `update-result.json` and `updates/ID.json` for inspection. Stop or expiry prevents rollback from starting another child.

For an explicit rollback after a successful deployment:

```bash
bun <skill>/scripts/mobile-service.mjs rollback ORIGIN_ID
bun <skill>/scripts/mobile-service.mjs status ORIGIN_ID
```

This uses the same bounded transaction and retained previous release. It does not delete files. If the worker crashes, its next start uses the last committed deployment; an uncommitted request bound to the old worker instance is rejected instead of replayed. A committed update ID with a missing result is reported as `recovered-commit`, never falsely described as retaining the old version. Interrupted or failed recovery must be checked again, never inferred from a process existing.

## Capability boundary and final verification

A running supervisor must advertise `workerProtocol: 2`. If the origin has ngrok, that live wrapper's ready receipt must advertise `maintenanceProtocol: 1`. Old processes do not acquire new code merely because a release was installed. Unsupported workers are rejected **before** stopping the app. Prefer an already supported app-native hot reload; otherwise arrange a separately reviewed maintenance migration. Do not recreate a healthy tunnel to satisfy a tool capability check, silently kill the old supervisor, or operate another chat's service.

After `ready` or `rolled-back`, verify the exact public URL and intended app version/content through the existing route:

```bash
bun <skill>/scripts/mobile-url-for-port.mjs ORIGINAL_PORT --service ORIGIN_ID --access ngrok --json
```

That reuse path verifies the existing binding/listener/URL without refreshing quota. Report URL unchanged or changed from the actual comparison, app version/result, same service ID and expiry. A 200 response proves the checked resource is reachable; it does not prove remaining monthly quota or the presence of large model/media assets. Verify those separately only when in scope.
