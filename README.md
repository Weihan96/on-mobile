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

### Recovery and shared entries

Use the bundled `mobile-delivery.mjs` for allowlisted MP4s, pages, assets and link indexes, and `mobile-links.mjs` to audit files, video bytes/codecs and existing transports. Restored services use `mobile-service.mjs start ... --inherit ORIGINAL_ID` to retain their original deadline. Supported delivery gateways can add and remove owned subpaths while preserving other routes; arbitrary existing servers require a reviewed migration. See [recovery configuration and verification](references/delivery-recovery.md).

### Updating a served application

Keep the same origin, port, tunnel and expiry. The owning chat can use `mobile-service.mjs update ID --cwd /absolute/new-release --ready /health --previous-ready /old-health -- bun server.mjs`, poll `status ID` for the result, and use `rollback ID` to return to the last release. Updates have a maximum 60-second maintenance window and automatic rollback on failed local readiness. Existing live workers must advertise support; an installation alone does not restart or upgrade them. Prefer app-native reload for older live workers. See [safe app updates and final URL verification](references/origin-updates.md).

### Persistent mobile mode

`off`, `auto` and `always` are saved at `~/.config/on-mobile/mobile-preview-mode`, independent of the skill installation and `CODEX_HOME`. Existing `set`/`get` commands remain the supported way to change/read the preference; `on` remains an alias for `always`. Missing or invalid state reports `auto` without overwriting a saved file.

Before replacing an older installation with a skill-local preference, use the new helper:

```bash
bun <new-skill>/scripts/mobile-mode.mjs migrate --from /absolute/old-skill/.local/mobile-preview-mode --json
bun <new-skill>/scripts/mobile-mode.mjs get --json
```

Migration retains the old file for rollback, accepts an identical preference, and stops if the external preference differs. After the installed helper reads the expected mode, retire the old in-tree copy and keep its backup. Reinstallations regenerate `agents/openai.yaml` from the saved mode; that generated badge is not the source of truth. If Codex still shows an older badge, reload the app. The old `CODEX_MOBILE_PREVIEW_MODE_FILE` override no longer relocates the preference.

### Private ngrok accounts

Keep the local account inventory at `~/.config/on-mobile/.env`, outside the installation; credentials remain in the existing protected ngrok configuration files. For an existing healthy route, reuse the original origin ID/port: stale or unknown quota does not require another login. For a new route/account selection, run `mobile-ngrok-accounts.mjs list`, verify the selected dashboard identity/current quota, record that observation with `check`, and pass `--ngrok-account ID` to the URL or Markdown helper. Manual switching uses `--switch-ngrok-from OLD_ID`. For authorized automatic selection, configure `rotation on --accounts ID,ID`, enroll the origin with `authorize SERVICE_ID`, then use `--ngrok-auto` on the URL helper. Selection and bounded quota failover run during that invocation; no background monitor is installed. Only its owned agent is replaced; the origin and original deadline are retained. See [account checks and switching](references/ngrok-fallback.md).

Replacing or deleting only the skill installation touches neither the external account inventory nor quota history (`ngrok-checks.json`), rotation settings (`ngrok-rotation.json`), or the mode preference at `~/.config/on-mobile/mobile-preview-mode`. Download an explicit release, verify its published checksum, inspect/extract it safely, then regenerate UI metadata with `mobile-mode.mjs get`; this reads the saved preference without resetting it. Those private files are not release assets.

For upgrades from the old in-tree inventory, run the new helper before removing the old installation:

```bash
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs migrate --from /absolute/old-skill/.env
bun <new-skill>/scripts/mobile-ngrok-accounts.mjs location
```

Migration preserves exact bytes, creates a private `0600` file, and refuses to overwrite a different destination. It retains the source until you have verified the new installation; then remove the old in-tree copy after backing it up. Normal reads never fall back to an in-tree `.env`.

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

小插件升级优先复用已有健康隧道；额度记录过期或未知，不再要求为了同一路由升级重新登录。新建/换账号仍需相应核对。应用可通过受管 `update` 原地换版本，失败按旧版健康路径回滚，原服务、端口和到期时间不变。旧常驻进程须先确认支持，安装新版脚本不会擅自重启它们。

手机模式偏好固定保存在 `~/.config/on-mobile/mobile-preview-mode`；升级或重装只替换技能目录，不会重置 `off/auto/always`。旧版本用上方 `mobile-mode.mjs migrate --from` 迁移，遇到不同的已存偏好会停止，不会覆盖。安装后运行 `get` 从已存偏好重新生成界面徽标；若显示仍旧，重新加载 Codex App。

账号清单固定保存在 `~/.config/on-mobile/.env`，与技能安装目录分离；只替换技能目录不会覆盖它。旧版本按上方 `migrate --from` 命令迁移，同内容可重复执行，不同内容会停止且不覆盖。确认新安装读取成功并保留备份后，再删除旧目录里的清单。

新增的恢复工具支持明确白名单中的视频、图册与链接汇总，检查真实文件、编码、分段响应及共享入口归属。恢复必须继承原截止时间；受支持的交付网关可添加独立子路径，回收时保留其他入口。既有自定义服务器须先验证迁移方案，当前可访问不代表共享代理重启后同一地址一定恢复。详见上方恢复文档。

## Credits and license / 致谢与许可

Created by Weihan96. Built on Apple's launchd, [Bun by Oven](https://bun.sh/), [Tailscale](https://github.com/tailscale/tailscale), [Markserv by the Markserv contributors](https://github.com/markserv/markserv), [ngrok](https://ngrok.com/), and [Vercel Labs' skills CLI](https://github.com/vercel-labs/skills). Dependencies retain their own licenses; no third-party binaries, credentials or preview files are bundled. MIT; see LICENSE.
