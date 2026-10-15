# Recover and share an existing delivery

Use this workflow for expired/broken previews, partial media failures, shared transport capacity, or moving a delivery away from a disposable worktree. It complements the existing origin/agent supervisor; it does not restart or take over arbitrary services.

## Inventory and classify first

Resolve the scripts from this skill's actual installation directory. Run:

```bash
bun scripts/mobile-links.mjs inventory 4040 4042
bun scripts/mobile-service.mjs status ORIGINAL_ID
```

API ports are explicit inputs, not a scan or a request to modify those agents. Inventory lists managed service state/deadlines and current ngrok endpoints. Independently establish task/user ownership of the original service, files, gateway and transport before any mutation. A matching port alone is not ownership. Do not evaluate code extracted from service argv, modify service.json, fabricate IDs, stop another service, or reset shared routing.

Classify each requested deliverable: available; origin/transport unavailable; missing file; deleted source root; empty source; incompatible/unverified media; or expired original. Keep missing items visible in the report. A surviving homepage or a different video cannot substitute for a missing recording. If a worktree was deleted, find an authorized intact copy or report unrecoverable; never silently regenerate acceptance evidence.

## Exact file configuration

Create the configuration in a stable task-owned delivery directory, outside this repository. Explicitly list every intended page, video, image, stylesheet and downloadable file. There is no recursive directory export. A gallery needs its index, linked pages and assets listed separately. Optional `sourceRoot` helps distinguish a deleted worktree from one missing file.

```json
{
  "version": 1,
  "title": "Review files",
  "basePath": "/review/",
  "files": [
    {"route": "/clip.mp4", "file": "/absolute/delivery/clip.mp4", "kind": "video", "audioRequired": true, "label": "Acceptance video"},
    {"route": "/gallery/", "file": "/absolute/delivery/gallery/index.html", "kind": "html", "label": "Drawing gallery"},
    {"route": "/gallery/front.png", "file": "/absolute/delivery/gallery/front.png", "kind": "asset"}
  ]
}
```

`kind` is `html`, `video` (MP4), or `asset`. Files must be nonempty regular files. Only exact configured URL paths are served; a changed symlink target is rejected. `label` adds an item to the generated index; an explicit `/` HTML file replaces that index. `basePath` ends in `/` and must match the final mount. URL paths have no encoded escapes, query, fragments or whitespace; choose simple aliases for filenames containing spaces. Query strings on requests do not select additional files.

HTML root-relative `href`, `src`, `poster`, `action` and root-relative `srcset` entries are prefixed through an HTML parser; ordinary relative links and external URLs remain relative/external. The proxy preserves the base path instead of applying another regex rewrite. Arbitrary JavaScript URL construction, CSS root URLs, dynamic application behavior, forms and authentication are not translated: explicitly adapt authorized delivery copies or retain the application's own hosting. Validate actual gallery navigation and all required assets. Do not claim support for untested dynamic pages.

Use a durable copy of only authorized delivery content if a worktree may be removed or macOS denies background reads. Preserve relative paths and validate checksums; do not delete the originals. No task media, personal configuration, private paths, credentials, generated receipts or third-party binaries belong in the public skill repository.

## Preserve the original lifetime

A new delivery gets seven days. Restoring/migrating an existing delivery inherits its original deadline:

```bash
bun scripts/mobile-service.mjs start --cwd /absolute/delivery --port FREE_PORT --inherit ORIGINAL_ID -- /absolute/bun /absolute/skill/scripts/mobile-delivery.mjs serve /absolute/delivery/config.json
```

The manager writes a new versioned manifest referring to the original, validates the ancestry, and rejects an already-expired original. Further migrations inherit the same deadline. Do not substitute a newer service ID or manually rewrite dates. Preserve an earlier known effective deadline from an original receipt; if its ancestry is unavailable or cannot be represented faithfully, stop and report the missing evidence instead of inventing a new lease. An explicit completion is not permission for automatic restoration; require the user's restoration request.

The config is read at startup. Once delivered, do not edit it in place while the service is running: make an authorized replacement inheriting the original lifetime and revalidate routing. Startup requires files to exist, but they can subsequently disappear; requests then fail visibly. A PID is not proof of file or URL availability.

## Shared gateway without a new public endpoint

A supported gateway is a `mobile-delivery.mjs serve` service configured with `"gateway": true`, `"basePath": "/"`, and its original allowlisted files. Its public transport is managed separately. It can retain its root/index and unrelated mounts while adding a new leaf delivery:

```bash
bun scripts/mobile-delivery.mjs mount GATEWAY_ID SOURCE_ID /review/
```

The source must be this tool's leaf delivery with the exact `/review/` base path, and the gateway deadline must cover the original source deadline. Do not shorten the source deadline or change its inheritance merely to fit an inadequate gateway. Files and existing mounts cannot be shadowed. Startup/config receipts and listening process ancestry are checked; the source's cleanup is registered before publishing its lease. The public address is the existing public origin plus `/review/`; no ngrok endpoint is created, renamed or deleted.

This is **not** an automatic adapter for an arbitrary existing server, Markserv or a runtime monkey-patch of `Bun.serve`. To migrate a custom static gateway, first inventory its exact routes and behavior, prepare a separate supported gateway with equivalent explicitly allowed pages/assets, inherit the old deadline, and test the old routes plus the new subpath. Move the transport only with authorization for that exact switch and a rollback plan. If preserving the current URL/routes cannot be verified without interrupting a live delivery, leave it running and report the migration constraint. Do not kill the current listener to make the new command fit.

Removing just the owned lease:

```bash
bun scripts/mobile-delivery.mjs unmount GATEWAY_ID SOURCE_ID /review/
```

After the user finishes this delivery, normally stop **SOURCE_ID** and wait for `closed`: its cleanup removes its own lease. A failed cleanup remains retryable; requests reject inactive/expired sources even before cleanup finishes. Do not stop the gateway or its shared ngrok agent for one completed leaf. Unmount alone does not stop an independently useful origin; its fixed lifetime still applies. Gateway stop removes availability of its mounts but does not claim ownership of those origins or kill them; each retains its own deadline.

## Verify a shared transport, do not assume it

`mobile-links.mjs transport CONFIG` is read-only. The JSON requires `publicUrl` (HTTPS origin), `apiPort`, `gatewayServiceId`, and one of:

- `transportServiceId`: an existing on-mobile `mobile-ngrok` service belonging to that gateway, with a current pinned-URL receipt and lifetime covering it.
- `launchdLabel`: a user LaunchAgent whose persisted command directly runs `ngrok http` with the exact pinned `--url`/`--domain` and loopback target. The tool compares API listener PID to the actual job and checks restart configuration.

```bash
bun scripts/mobile-links.mjs transport /absolute/delivery/transport.json
```

`verified-supervised` means the inspected process/receipt/startup chain supports the exact endpoint. `available-unverified` means an endpoint exists but that proof is missing; an API-created transient tunnel under a persistent agent is a common example. `unavailable` means the endpoint/origin check failed. `gatewayExpiresAt` describes that gateway's manifest, **not** a replacement for the original source's earlier effective deadline. Custom wrappers/config-only tunnel definitions may require additional independent evidence; the helper fails closed rather than claiming them verified.

Even a pinned address depends on provider/account/network availability. On endpoint exhaustion, domain ownership rejection or `ERR_NGROK_313`, retain the concrete error. Do not retry by killing shared agents, deleting others' endpoints, changing account configuration, extending deadlines or silently issuing a different URL. State current reachability separately from restart/lifetime guarantees.

## Verify actual content and report limits

For auditing, add `publicUrl` (the public origin) and `inheritFrom` (the original lifetime service) to a **separate audit copy** of the config. An individual file's optional `url` checks its old exact address instead. These fields do not change server routing or lifecycle.

```bash
bun scripts/mobile-links.mjs audit /absolute/delivery/audit.json --decode
```

The audit reports each file separately. Video checks inspect H.264/AAC streams with `ffprobe` (`audioRequired` enforces an audio track); `--decode` uses silent `ffmpeg` decoding. Install both with `brew install ffmpeg`; verify `ffmpeg -version` and `ffprobe -version`. Public video checks require MP4 MIME, real GET Range 206, matching range/total/length and bytes matching the declared local video. Images/assets require their expected MIME and matching prefix bytes, so an HTML fallback returning 200 is rejected. HTML checks confirm endpoint/MIME only; inspect the page, links and player separately. The JSON always states `playbackTested: false`; it is not a phone/browser playback claim. Do not treat CLI exit zero alone as acceptance—inspect each `state` and unresolved failure.

Report original/current URL, service IDs, original effective expiry, each available/missing item, ownership and cleanup scope, exact verification performed, and any URL or restart limitation. Do not claim a permanent link or renew the lifetime during recovery, restart, probes, publishing or skill installation.

## Maintainer verification

Run `bun test` for regression tests. On macOS with FFmpeg installed, run `bun tests/mobile-delivery-live.mjs` for an isolated localhost launchd test: actual video decoding/Range, crash restart with unchanged deadline, prefix reuse, and cleanup preserving the original gateway page. It closes its own test services and prints an evidence path; it neither creates public tunnels nor verifies phone playback.
