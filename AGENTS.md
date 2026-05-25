# Agent Deployment Guide

This file is written for coding agents that need to install, verify, or deploy this bridge without guessing.

## Goal

Run a local Feishu Bot bridge:

```text
Feishu long-connection events -> local Node.js bridge -> Codex CLI -> Feishu replies
```

No public HTTP callback service is required.

## Hard Rules

- Never commit `.env`, `.state.json`, `bridge.pid`, or `*.log`.
- Never print `FEISHU_APP_SECRET`.
- Keep `CODEX_TRANSPORT=exec` unless the user explicitly asks for a persistent terminal process.
- Keep `CODEX_ROOT` as the filesystem safety boundary. Do not let `/cd` escape it.
- Run `npm run check` after code changes.
- Run `npm run doctor` after environment changes.

## Prerequisites

- Node.js 20 or newer.
- Codex CLI installed and authenticated.
- A Feishu self-built app with long-connection event subscription enabled.
- Feishu Bot permissions for receiving messages, sending messages, and uploading image resources.

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

## Required `.env`

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ALLOW_ALL=false
CODEX_ROOT=/absolute/path/to/projects
CODEX_CWD=/absolute/path/to/projects
CODEX_TRANSPORT=exec
```

On Windows, paths can use `C:\...`. On macOS/Linux, use `/Users/...` or another absolute path.

## Start And Stop

Windows background start:

```powershell
.\scripts\start-bridge.ps1
```

Windows stop:

```powershell
.\scripts\stop-bridge.ps1
```

macOS/Linux background start:

```bash
bash scripts/start-bridge.sh
```

macOS/Linux stop:

```bash
bash scripts/stop-bridge.sh
```

Foreground:

```bash
npm start
```

## Verification

1. Send `/help` to the Bot.
2. Send `/pwd`.
3. Send `/cd <project-name>`.
4. Send a normal prompt, for example: `summarize this repo`.
5. Send `/status`; it should show `thread_id` after a Codex turn has started.
6. If Codex creates an image under the current working directory, the bridge should upload and send it as a Feishu image message.

## Troubleshooting

- No reply: check `bridge.err.log` and Feishu long-connection event subscriptions.
- Unauthorized reply: send `/whoami`, then add the returned id to the allow list in `.env`.
- Codex says not trusted: the bridge adds `--skip-git-repo-check` for non-git directories in exec mode.
- Images do not show: verify Feishu image/resource permission and `AUTO_SEND_IMAGES=true`.
