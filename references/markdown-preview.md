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
3. Starts Markserv bound to `0.0.0.0`.
4. Verifies the local rendered Markdown URL returns HTML.
5. Verifies at least one local relative image when the rendered HTML contains images.
6. Prefers a verified Tailscale URL when Tailscale is running.
7. Falls back to Tailscale Serve when direct access fails and Serve is safe to create.
8. Falls back to ngrok only when Tailscale is unavailable or `--access ngrok` is requested.
9. Verifies the final mobile URL and reports whether it is tailnet-only or public.

## Markserv Policy

- First use a stable installed command discovered with `command -v markserv`.
- If no stable `markserv` command exists, use `bunx markserv` only as a temporary fallback for the current preview.
- When the fallback is used, tell the user that repeated use should install Markserv persistently:

```bash
bun add -g markserv
```

- Do not rely on or document Bun's temporary `bunx-*` cache paths as stable Markserv entrypoints.
- Do not automatically run a global install unless the user explicitly asks for persistent installation.

## Process Lifetime

For previews that need to stay open while the user checks a mobile link, keep the server process attached to a live foreground command session.

Good:

```bash
bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs ./README.md --access tailscale
```

Let the command continue running and keep the returned session id. Stop it with `Ctrl+C` after the user is done.

Avoid:

```bash
nohup bun /Users/jiaxinchen/.codex/skills/on-mobile/scripts/serve-markdown-mobile.mjs ./README.md > /tmp/mobile-preview.log 2>&1 &
```

Do not rely on `nohup ... &`, shell background jobs, or one-shot detached commands from Codex tool calls for live previews; those processes may be reclaimed after the parent command exits, making the mobile URL stop responding even when Markserv itself is healthy.

If a durable background preview is needed, use or implement an explicit daemon mode with its own lifecycle, pid file, logs, health check, and cleanup command instead of improvising with shell backgrounding.

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
