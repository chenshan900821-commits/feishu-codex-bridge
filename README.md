# Feishu Codex Bridge

Run Codex CLI from a Feishu Bot without exposing a public callback URL.

```text
Feishu Bot long-connection events
  -> local Node.js bridge
  -> Codex CLI
  -> Feishu text/post/image replies
```

The bridge runs on the same machine where your projects and Codex CLI already live. Feishu is the chat entry point; Codex still works against local files.

## Features

- Receives Feishu Bot messages through long-connection events.
- Sends prompts to Codex CLI.
- Preserves Codex context with `codex exec resume <thread_id>`.
- Lets users switch project directories under a configured `CODEX_ROOT`.
- Supports allow-listing by Feishu user or chat id.
- Sends long answers as richer Feishu post messages.
- Uploads generated images back to Feishu.
- Downloads inbound Feishu image messages and attaches them to Codex CLI with `--image`.
- Includes Windows and macOS/Linux install/start/stop scripts.
- Includes [AGENTS.md](AGENTS.md) so another agent can install and deploy it without guessing.

## Documentation

- [Deployment guide](docs/DEPLOY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Agent deployment guide](AGENTS.md)
- [WeChat article draft](docs/articles/wechat-feishu-codex-bridge.md)
- [WeChat copy-ready HTML](docs/articles/wechat-copy.html), generated with `npm run build:wechat`

## Feishu App Setup

1. Open your self-built app in Feishu Open Platform.
2. Enable Bot capability.
3. Enable long-connection event subscription.
4. Subscribe to `im.message.receive_v1`.
5. Subscribe to `application.bot.menu_v6` if you want Bot menus.
6. Add permissions for receiving messages, sending messages, and uploading message images/resources.
7. Publish the app version after permission or menu changes.
8. Add the Bot to the target group chat, or send the Bot a direct message.

## Install

Windows:

```powershell
.\scripts\install.ps1
notepad .env
npm run doctor
```

macOS/Linux:

```bash
bash scripts/install.sh
$EDITOR .env
npm run doctor
```

Required config:

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

`CODEX_ROOT` is the safety boundary. The Bot can only switch Codex into directories under that root.

Leave `CODEX_COMMAND=` empty unless Codex is not on `PATH`. The bridge auto-detects `codex.cmd` on Windows and `codex` on macOS/Linux.

## Run

Foreground:

```bash
npm start
```

Windows background:

```powershell
.\scripts\start-bridge.ps1
```

macOS/Linux background:

```bash
bash scripts/start-bridge.sh
```

Stop:

```powershell
.\scripts\stop-bridge.ps1
```

```bash
bash scripts/stop-bridge.sh
```

## Commands

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

Examples:

```text
/pwd
/dirs
/cd demo-project
/cd D:\Projects\demo-project
/images
```

`/cd` stops the current Codex session and clears the saved thread for that chat. The next plain-text message starts a new context in the selected directory.

## Codex Runtime Model

The default mode is:

```env
CODEX_TRANSPORT=exec
```

Each Feishu prompt starts a short-lived `codex exec` process. Follow-up prompts use `codex exec resume <thread_id>`, so Codex context is preserved even though the OS process exits after each turn.

This is more reliable for a chat bot than a persistent terminal UI process because the bridge can parse JSONL events, extract final answers, detect command failures, and upload generated images.

Long-running Codex runs send heartbeat updates:

```env
EXEC_HEARTBEAT_MS=120000
EXEC_TIMEOUT_MINUTES=30
```

Set `EXEC_HEARTBEAT_MS=0` to disable heartbeat messages.

Normal shell-command noise is hidden by default:

```env
SHOW_COMMAND_PROGRESS=false
SHOW_TURN_PROGRESS=true
```

Generated images are auto-detected under the current Codex working directory and sent as Feishu image messages:

```env
AUTO_SEND_IMAGES=true
MAX_IMAGES_PER_RUN=5
MAX_IMAGE_MB=10
```

Inbound image messages are supported in `CODEX_TRANSPORT=exec`. When a user sends an image to the Bot, the bridge downloads the message resource into `.codex-inbox/feishu-images/` under the selected Codex working directory, then calls Codex with `--image <file>`.

## Bot Menu

You can show common entries on the cc Bot by configuring custom Bot menus in Feishu Open Platform.

Add event-type menu items with these event keys:

```text
help
codex_guide
examples
dirs
status
```

Required event subscription:

```text
application.bot.menu_v6
```

Suggested menu labels:

```text
Help -> help
How Codex Works -> codex_guide
Examples -> examples
Projects -> dirs
Status -> status
```

Menu clicks send a private message to the operator. Work that touches files should still be sent as plain text in the Bot chat after choosing a directory with `/cd`.

## Security Notes

- Keep `FEISHU_ALLOW_ALL=false` for real use.
- Add only your own `open_id`, `user_id`, `union_id`, or trusted `chat_id` to the allow list.
- Keep `.env` local and uncommitted.
- Keep `CODEX_SANDBOX=workspace-write` unless you explicitly need broader filesystem access.
- Keep `CODEX_ROOT` narrow.

## Verification

```bash
npm run check
npm run doctor
npm audit --audit-level=high
```
