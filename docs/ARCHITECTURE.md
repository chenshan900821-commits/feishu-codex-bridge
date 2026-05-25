# Architecture

## Components

```text
Feishu Bot
  |
  | long-connection event
  v
Node.js bridge
  |
  | codex exec --json / codex exec resume <thread_id>
  v
Codex CLI
  |
  | JSONL events, final text, generated files
  v
Node.js bridge
  |
  | text/post/image messages
  v
Feishu chat
```

## Why Long Connection

Feishu supports receiving events through a persistent connection. This avoids a public callback URL, reverse proxy, or webhook backend. The bridge can run on the same machine where Codex CLI already has access to the user's projects.

## Why `exec` Is The Default

`CODEX_TRANSPORT=exec` starts one short-lived Codex CLI process per prompt. It then stores the returned Codex `thread_id` and uses `codex exec resume <thread_id>` for follow-up prompts.

This gives the Bot stable structured output while preserving conversation context.

The alternative `CODEX_TRANSPORT=pty` keeps an interactive terminal process alive. It is useful for experiments, but it is harder to parse reliably in Feishu because terminal UIs emit screen-control sequences rather than clean JSONL events.

## State

`.state.json` stores:

- selected working directory per Feishu chat
- Codex thread id per Feishu chat

The file is local runtime state and must not be committed.

## Directory Boundary

`CODEX_ROOT` is the safety boundary. `/cd` resolves relative or absolute paths and rejects paths outside that root.

## Generated Images

Before each Codex turn, the bridge snapshots image files under the current working directory. After the turn, it scans again and uploads new or modified images to Feishu.

Supported image extensions:

```text
.png .jpg .jpeg .webp .gif .bmp
```

Large directories such as `node_modules`, `.git`, `dist`, and `build` are skipped.
