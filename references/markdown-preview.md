# Markdown Preview

Use this reference when serving local Markdown files, READMEs, design notes, reports, or Markdown artifacts to a phone.

## Helper Flow

Prefer the bundled helper:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs <markdown-file-or-directory>
```

The helper:

1. Resolves the Markdown target.
2. Serves the git repository root when the target is inside a git repo; otherwise serves the Markdown file's parent directory or the requested directory.
3. Starts a launchd-managed Markserv bound to `0.0.0.0` with a fixed seven-day lifetime.
4. Verifies the local rendered Markdown URL returns HTML.
5. Verifies at least one local relative image when the rendered HTML contains images.
6. Prefers a verified Tailscale URL when Tailscale is running.
7. Falls back to Tailscale Serve when direct access fails and Serve is safe to create.
8. Falls back to ngrok only when Tailscale is unavailable or `--access ngrok` is requested.
9. Verifies the final mobile URL and reports whether it is tailnet-only or public.

## Markserv and Process Lifetime

Use a stable installed `markserv` executable. If missing, request/obtain the usual installation authorization and install with `bun add -g markserv`; verify `markserv --version`. Do not use a temporary `bunx` cache as a week-long daemon entrypoint.

The helper launches itself and Markserv through `mobile-service.mjs` under macOS launchd. It returns after validating the page/images; no foreground tool session is required. Keep the returned service until the user explicitly confirms completion or seven days from creation. Probes, playback, inactivity, task completion and restarts do not count as completion or renew expiry.

After user confirmation, run `mobile-service.mjs stop <service-id>`; verify `status <service-id>` reaches `closed`. Failed cleanup remains recorded and retryable. Only this service and its owned route are removed; Markdown, images, videos and other tasks' services remain. Never use global `tailscale serve reset` or kill a shared ngrok agent for cleanup.

The Mac must remain awake, connected and logged in for local access. On wake/login after expiry, the worker cleans up before starting the origin. On unsupported platforms use an equivalent supervised host with the same lifetime, or report the missing capability. Do not fall back to foreground sessions or `nohup ... &`.

## Relative Images

Choose the served root so Markdown image paths keep working. For example, if `docs/design/note.md` contains `![x](./note/01.png)`, serving the repository root and opening `/docs/design/note.md` should keep the image URL valid.

Validation:

- Check the local Markdown page returns `200` and `content-type: text/html`.
- If images are present, check at least one local image returns `200`.
- Check the final mobile URL returns HTML.
- If image validation fails but the page renders, still give the page URL and mention that image paths or the served root may need adjustment.

## Codex Mobile Rendering

When composing Markdown directly for a Codex mobile user, do not assume the mobile conversation renderer supports full GitHub-flavored Markdown or arbitrary HTML. Prefer plain tables, normal links, blockquotes, and code blocks.

Avoid relying on GitHub callouts, HTML `<details>`, or remote URL Markdown image rendering inside the conversation. Local host file-path images may render when Codex can access the file, but still provide a normal link, artifact, or mobile preview URL when the image is important.

For the observed support matrix and safer alternatives, read `codex-mobile-markdown-rendering.md`.
