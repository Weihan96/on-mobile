# on-mobile

Keep phone preview links alive after the agent task ends, until you explicitly finish or seven days pass.

让手机预览链接在任务结束后继续可用：你明确确认看完时关闭，否则创建满七天自动回收。

## English

### Requirements

- [ ] Codex with local shell access: install from https://developers.openai.com/codex/quickstart/ and verify `codex --version`.
- [ ] macOS with a logged-in user for the bundled launchd manager. Verify `launchctl help`. Other hosts need equivalent supervised hosting and expiry.
- [ ] Bun: install from https://bun.sh/docs/installation and verify `bun --version`.
- [ ] Tailscale on the Mac and phone, signed into the same tailnet: install from https://tailscale.com/download and verify `tailscale status`. The Mac app CLI may instead live at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- [ ] For Markdown, install Markserv with `bun add -g markserv`; verify `markserv --version`.
- [ ] For optional public access, install ngrok from https://ngrok.com/download, complete its account setup, and verify `ngrok version`. Keep credentials in its protected configuration.

### Install and check

1. Install globally, preserving any existing customizations first:

   ```bash
   bunx --bun skills add Weihan96/on-mobile --agent codex --skill on-mobile --global --yes
   bunx --bun skills list --agent codex --global
   ```

2. Invoke `$on-mobile` on the next Codex turn. Resolve script paths from the actual installation directory; examples in skill references may use the author's installation path.
3. To inspect and test the source:

   ```bash
   git clone https://github.com/Weihan96/on-mobile.git
   cd on-mobile
   bun test tests
   bun scripts/mobile-mode.mjs get
   ```

### Try saying

- “Let me open this dashboard on my phone.”
- “Give me a mobile link to this Markdown report and keep it running.”
- “I've finished reviewing that preview; close its service.”

The skill prefers private Tailscale URLs and uses ngrok when public access is required or Tailscale is unavailable. Both origin and tunnel are supervised. A task ending, page view, playback completion or inactivity never counts as your confirmation. Restarting or probing does not renew the fixed seven-day deadline.

### Limits and troubleshooting

Local hosting requires the Mac awake, online and logged in. On resume after expiry, cleanup runs before serving again. ngrok URLs are public; provider account limits and availability still apply. Only owned services/routes are reclaimed; source files and other tasks' services remain. The helper refuses an unmanaged source or an unrelated ngrok listener on port 4040.

| Problem | Action |
| --- | --- |
| Port occupied | Use a free origin port; do not kill another task's listener. An existing ngrok agent requires an authorized migration or isolated supervised setup. |
| Background process cannot read Documents | Stage only intended delivery files and assets under a stable task-owned `~/.codex/mobile-previews/` directory, preserve relative paths, and recheck readiness. |
| Phone cannot reach Tailscale | Check both devices' tailnet login and VPN state; use public access only when appropriate. |
| Cleanup reports `cleanup_failed` | Inspect the service receipt/log and retry scoped cleanup; do not reset shared routes or claim it is closed. |
| Markserv missing | Run `bun add -g markserv`, then `markserv --version`; a temporary package cache is not a durable entrypoint. |

Tests cover fixed expiry, ownership, cleanup retries, crash-safe locks and pinned ngrok URL recovery. They do not replace a live final-URL probe; ngrok tests use controlled fixtures.

## 中文

### 安装与依赖

- [ ] 安装上方链接中的 Codex、Bun，并用 `codex --version`、`bun --version` 检查。
- [ ] 内置常驻管理器需要 macOS 登录会话；用 `launchctl help` 检查。其他系统需要等效托管与回收机制。
- [ ] 从上方链接安装 Tailscale，电脑和手机加入同一网络，用 `tailscale status` 检查。
- [ ] Markdown 预览执行 `bun add -g markserv`，再用 `markserv --version` 检查。
- [ ] 需要公网链接时，从上方链接安装并配置 ngrok，用 `ngrok version` 检查；凭据保存在其受保护配置中。

1. 执行上方全局安装命令，并用 `skills list` 确认发现技能。已有同名安装先保留个人定制。
2. 下一轮对话使用 `$on-mobile`；脚本路径以实际安装目录为准。
3. 需要验源码时按上方命令克隆，执行 `bun test tests`。

可以说：“让我用手机打开这个页面”“把这份 Markdown 发成手机链接并保持运行”“我看完了，把刚才的预览关掉”。

默认优先私有 Tailscale 链接；必要时使用公网 ngrok。源服务和隧道均由系统管理。用户明确确认用完才提前回收，否则创建满七天关闭；访问、播放完成、任务结束或重启都不续期。不会删除交付文件或关闭其他任务的服务。

电脑仍须唤醒、联网并登录，daemon 不代表离线也能访问。ngrok 是公网服务，受账号与平台限制。端口占用时换空闲端口，不杀别人的进程；后台无法读 Documents 时，将交付内容放到稳定的 `~/.codex/mobile-previews/` 子目录；手机无法连接时检查 Tailscale/VPN；回收失败时查看日志并重试，不重置共享路由。

## Credits and license / 致谢与许可

Created by Weihan96. Built on Apple's launchd, [Bun by Oven](https://bun.sh/), [Tailscale](https://github.com/tailscale/tailscale), [Markserv by the Markserv contributors](https://github.com/markserv/markserv), [ngrok](https://ngrok.com/), and [Vercel Labs' skills CLI](https://github.com/vercel-labs/skills). Dependencies retain their own licenses; no third-party binaries, credentials or preview files are bundled. MIT; see LICENSE.
