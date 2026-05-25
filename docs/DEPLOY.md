# Deployment Guide

This bridge is designed to run on a local developer machine or a small always-on workstation. It uses Feishu's long-connection event mode, so it does not need a public backend callback URL.

## 1. Prerequisites

- Node.js 20 or newer
- npm
- Codex CLI installed and logged in
- A Feishu self-built app
- A Feishu Bot added to the chat where you want to use Codex

## 2. Feishu App Configuration

In Feishu Open Platform:

1. Create or open a self-built app.
2. Enable Bot capability.
3. Enable long-connection event subscription.
4. Subscribe to:
   - `im.message.receive_v1`
   - `application.bot.menu_v6` if you want Bot menus
5. Add permissions for:
   - receiving messages
   - sending messages
   - uploading message images/resources
6. Publish the app version after changing permissions or menus.

## 3. Install

Windows:

```powershell
git clone <your-repo-url>
cd feishu-codex-bridge
.\scripts\install.ps1
```

macOS:

```bash
git clone <your-repo-url>
cd feishu-codex-bridge
bash scripts/install.sh
```

## 4. Configure `.env`

Copy `.env.example` to `.env` if the install script did not already create it.

Required values:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ALLOW_ALL=false
CODEX_ROOT=/absolute/path/to/projects
CODEX_CWD=/absolute/path/to/projects
CODEX_TRANSPORT=exec
```

Windows path example:

```env
CODEX_ROOT=D:\Projects
CODEX_CWD=D:\Projects
```

macOS path example:

```env
CODEX_ROOT=/Users/alice/Projects
CODEX_CWD=/Users/alice/Projects
```

Leave `CODEX_COMMAND=` empty unless Codex is not on `PATH`. The bridge auto-detects `codex.cmd` on Windows and `codex` on macOS/Linux.

## 5. Verify

```bash
npm run check
npm run doctor
```

`doctor` checks Node, required env vars, Codex CLI availability, and whether `CODEX_CWD` stays inside `CODEX_ROOT`.

## 6. Run

Foreground:

```bash
npm start
```

Windows background:

```powershell
.\scripts\start-bridge.ps1
Get-Content .\bridge.out.log -Tail 80
```

macOS background:

```bash
bash scripts/start-bridge.sh
tail -n 80 bridge.out.log
```

Stop:

```powershell
.\scripts\stop-bridge.ps1
```

```bash
bash scripts/stop-bridge.sh
```

## 7. Bot Commands

```text
/help
/codex
/examples
/whoami
/status
/pwd
/images
/dirs
/dirs <path>
/cd <path>
/new
/new <prompt>
/resume-last
/stop
```

## 8. Operating Model

The default mode is `CODEX_TRANSPORT=exec`.

That means each Feishu prompt starts a short-lived `codex exec` process. Follow-up prompts resume the stored Codex `thread_id`, so context is preserved even though the OS process exits after each turn.

This is more reliable for a chat bot than keeping a terminal UI process alive, because the bridge can parse JSONL events, extract final answers, detect command failures, and upload generated images.

## 9. Image Output

If Codex creates or modifies images under the current working directory, the bridge uploads them to Feishu and sends image messages.

Relevant config:

```env
AUTO_SEND_IMAGES=true
MAX_IMAGES_PER_RUN=5
MAX_IMAGE_MB=10
```

You can also send `/images` to manually send recent images from the current project directory.

## 10. Security

- Keep `.env` local and uncommitted.
- Use `FEISHU_ALLOW_ALL=false` outside quick testing.
- Prefer allow-listing a chat id or your own Feishu user id.
- Keep `CODEX_SANDBOX=workspace-write` unless you intentionally need broader access.
- Set `CODEX_ROOT` narrowly. It is the boundary for `/cd`.
