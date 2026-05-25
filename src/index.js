'use strict';

require('dotenv').config();

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Lark = require('@larksuiteoapi/node-sdk');

let pty = null;
try {
  pty = require('node-pty');
} catch (error) {
  // node-pty is strongly preferred for an interactive CLI, but the bridge can
  // still run in a degraded pipe mode if native installation fails.
  pty = null;
}

const DEFAULT_CODEX_COMMAND = process.platform === 'win32' ? 'codex.cmd' : 'codex';
const codexRoot = path.resolve(process.env.CODEX_ROOT || process.env.CODEX_CWD || process.cwd());
const defaultCodexCwd = resolveInsideRoot(codexRoot, process.env.CODEX_CWD || codexRoot);

const config = {
  feishuAppId: requiredEnv('FEISHU_APP_ID'),
  feishuAppSecret: requiredEnv('FEISHU_APP_SECRET'),
  feishuAllowAll: boolEnv('FEISHU_ALLOW_ALL', false),
  allowedOpenIds: csvSet('FEISHU_ALLOWED_OPEN_IDS'),
  allowedUserIds: csvSet('FEISHU_ALLOWED_USER_IDS'),
  allowedUnionIds: csvSet('FEISHU_ALLOWED_UNION_IDS'),
  allowedChatIds: csvSet('FEISHU_ALLOWED_CHAT_IDS'),
  codexRoot,
  defaultCodexCwd,
  codexCommand: process.env.CODEX_COMMAND || DEFAULT_CODEX_COMMAND,
  codexTransport: normalizeTransport(process.env.CODEX_TRANSPORT),
  codexModel: cleanEnv('CODEX_MODEL'),
  codexSandbox: process.env.CODEX_SANDBOX || 'workspace-write',
  codexApproval: process.env.CODEX_APPROVAL || 'on-request',
  codexEnableSearch: boolEnv('CODEX_ENABLE_SEARCH', false),
  codexExtraArgs: splitArgs(process.env.CODEX_EXTRA_ARGS || ''),
  sessionIdleMs: numberEnv('SESSION_IDLE_MINUTES', 120) * 60 * 1000,
  outputFlushMs: numberEnv('OUTPUT_FLUSH_MS', 1500),
  outputChunkChars: numberEnv('OUTPUT_CHUNK_CHARS', 3500),
  postChunkChars: numberEnv('POST_CHUNK_CHARS', 2800),
  execHeartbeatMs: nonNegativeNumberEnv('EXEC_HEARTBEAT_MS', 120000),
  execTimeoutMs: numberEnv('EXEC_TIMEOUT_MINUTES', 30) * 60 * 1000,
  showCommandProgress: boolEnv('SHOW_COMMAND_PROGRESS', false),
  showTurnProgress: boolEnv('SHOW_TURN_PROGRESS', true),
  autoSendImages: boolEnv('AUTO_SEND_IMAGES', true),
  maxImagesPerRun: numberEnv('MAX_IMAGES_PER_RUN', 5),
  maxImageBytes: numberEnv('MAX_IMAGE_MB', 10) * 1024 * 1024,
  logLevel: process.env.LOG_LEVEL || 'info',
};

const client = new Lark.Client({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
});

const statePath = path.join(__dirname, '..', '.state.json');

class TtlSet {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  has(key) {
    this.prune();
    return this.items.has(key);
  }

  add(key) {
    this.prune();
    this.items.set(key, Date.now());
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, createdAt] of this.items.entries()) {
      if (createdAt < cutoff) {
        this.items.delete(key);
      }
    }
  }
}

const sessions = new Map();
const bridgeState = loadBridgeState();
const selectedCwds = bridgeState.selectedCwds;
const savedSessionIds = bridgeState.sessionIds;
const seenMessageIds = new TtlSet(10 * 60 * 1000);

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    setImmediate(() => {
      handleMessageEvent(data).catch((error) => {
        log('error', 'message handler failed', error);
      });
    });
  },
  'application.bot.menu_v6': async (data) => {
    setImmediate(() => {
      handleMenuEvent(data).catch((error) => {
        log('error', 'menu handler failed', error);
      });
    });
  },
});

const wsClient = new Lark.WSClient({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
  loggerLevel: config.logLevel === 'debug' ? Lark.LoggerLevel.debug : Lark.LoggerLevel.info,
});

wsClient.start({ eventDispatcher });

log('info', `bridge started, root=${config.codexRoot}, defaultCwd=${config.defaultCodexCwd}, command=${config.codexCommand}`);
log('info', `transport=${config.codexTransport}${config.codexTransport === 'pty' && !pty ? ' requested, but node-pty unavailable' : ''}`);

setInterval(stopIdleSessions, 60 * 1000).unref();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function handleMessageEvent(data) {
  log('info', `raw message event keys=${Object.keys(data || {}).join(',')}`);
  const message = data && data.message;
  if (!message || !message.chat_id || !message.message_id) {
    log('warn', 'ignored event without message/chat_id/message_id');
    return;
  }

  if (seenMessageIds.has(message.message_id)) {
    return;
  }
  seenMessageIds.add(message.message_id);

  const senderId = (data.sender && data.sender.sender_id) || {};
  const chatId = message.chat_id;
  const sessionKey = chatId;
  log(
    'info',
    `message received id=${message.message_id}, type=${message.message_type}, chat=${chatId}, open_id=${senderId.open_id || ''}`,
  );

  if (!isAllowed(senderId, chatId)) {
    await sendText(
      chatId,
      [
        '未授权，Codex CLI 没有启动。',
        '',
        '把下面任意一个 id 加到 .env 后重启 bridge：',
        `open_id: ${senderId.open_id || '(empty)'}`,
        `user_id: ${senderId.user_id || '(empty)'}`,
        `union_id: ${senderId.union_id || '(empty)'}`,
        `chat_id: ${chatId}`,
      ].join('\n'),
    );
    return;
  }

  if (message.message_type !== 'text') {
    await sendText(chatId, '暂时只支持文本消息。');
    return;
  }

  const text = extractText(message.content);
  log('info', `parsed text=${JSON.stringify(text)}`);
  if (!text) {
    return;
  }

  if (text.startsWith('/')) {
    await handleCommand(sessionKey, chatId, text, senderId);
    return;
  }

  const session = ensureSession(sessionKey, chatId, { resumeLast: false });
  session.writeUserText(text);
}

async function handleMenuEvent(data) {
  const eventKey = String((data && data.event_key) || '').trim();
  const operatorId = (data && data.operator && data.operator.operator_id) || {};
  const openId = operatorId.open_id;
  log('info', `menu event key=${eventKey}, open_id=${openId || ''}`);

  if (!openId) {
    log('warn', 'ignored menu event without operator open_id');
    return;
  }

  if (!isAllowed(operatorId, '')) {
    await sendTextToOpenId(openId, unauthorizedText(operatorId, ''));
    return;
  }

  switch (eventKey) {
    case 'help':
      await sendTextToOpenId(openId, helpText());
      return;
    case 'codex_guide':
      await sendTextToOpenId(openId, codexGuideText());
      return;
    case 'examples':
      await sendTextToOpenId(openId, examplesText());
      return;
    case 'dirs':
      await sendTextToOpenId(openId, 'In a chat with cc, send:\n/dirs\n/cd <project-name>');
      return;
    case 'status':
      await sendTextToOpenId(openId, 'In a chat with cc, send /status or /pwd.');
      return;
    default:
      await sendTextToOpenId(openId, `Unknown menu key: ${eventKey || '(empty)'}\nUse keys: help, codex_guide, examples, dirs, status.`);
  }
}

async function handleCommand(sessionKey, chatId, text, senderId) {
  const [command] = text.split(/\s+/);
  const payload = text.slice(command.length).trim();
  const normalizedCommand = command.toLowerCase();

  if (normalizedCommand === '/help') {
    await sendText(chatId, helpText());
    return;
  }
  if (normalizedCommand === '/codex') {
    await sendText(chatId, codexGuideText());
    return;
  }
  if (normalizedCommand === '/examples') {
    await sendText(chatId, examplesText());
    return;
  }

  switch (normalizedCommand) {
    case '/help':
      await sendText(
        chatId,
        [
          '可用命令：',
          '/help - 显示帮助',
          '/whoami - show Feishu sender ids for allow-list setup',
          '/status - 查看当前会话',
          '/pwd - show current Codex working directory',
          '/dirs - list child directories',
          '/dirs <path> - list child directories under path',
          '/cd <path> - switch Codex working directory under CODEX_ROOT',
          '/new - 重开一个 Codex 会话',
          '/new <prompt> - 重开会话并发送首条消息',
          '/resume-last - 使用 codex resume --last',
          '/stop - 停止当前 Codex 进程',
          '',
          '普通文本会发送给当前 Codex 会话。',
        ].join('\n'),
      );
      return;

    case '/whoami':
      await sendText(
        chatId,
        [
          `open_id: ${senderId.open_id || '(empty)'}`,
          `user_id: ${senderId.user_id || '(empty)'}`,
          `union_id: ${senderId.union_id || '(empty)'}`,
          `chat_id: ${chatId}`,
        ].join('\n'),
      );
      return;

    case '/status': {
      const session = sessions.get(sessionKey);
      await sendText(chatId, session ? formatSessionStatus(session) : `No Codex session is active.\ncwd=${getSelectedCwd(sessionKey)}`);
      return;
    }

    case '/pwd':
      await sendText(chatId, getSelectedCwd(sessionKey));
      return;

    case '/images': {
      const images = listImages(getSelectedCwd(sessionKey))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, config.maxImagesPerRun);
      if (!images.length) {
        await sendText(chatId, 'No images found in the current project directory.');
        return;
      }
      await sendText(chatId, `Latest image${images.length > 1 ? 's' : ''}:`);
      for (const image of images) {
        await sendImage(chatId, image.path);
      }
      return;
    }

    case '/dirs': {
      const resolved = payload ? resolveUserPath(sessionKey, payload) : { ok: true, value: getSelectedCwd(sessionKey) };
      if (!resolved.ok) {
        await sendText(chatId, resolved.error);
        return;
      }
      const target = resolved.value;
      await sendText(chatId, formatDirectories(target));
      return;
    }

    case '/cd': {
      if (!payload) {
        await sendText(chatId, 'Usage: /cd <directory>');
        return;
      }
      const resolved = resolveUserPath(sessionKey, payload);
      if (!resolved.ok) {
        await sendText(chatId, resolved.error);
        return;
      }
      const nextCwd = resolved.value;
      if (!fs.existsSync(nextCwd) || !fs.statSync(nextCwd).isDirectory()) {
        await sendText(chatId, `Directory does not exist:\n${nextCwd}`);
        return;
      }
      stopSession(sessionKey, 'cwd changed');
      selectedCwds.set(sessionKey, nextCwd);
      savedSessionIds.delete(sessionKey);
      saveBridgeState();
      await sendText(chatId, `Codex cwd changed:\n${nextCwd}`);
      return;
    }

    case '/new': {
      stopSession(sessionKey, 'restarting');
      savedSessionIds.delete(sessionKey);
      saveBridgeState();
      const session = ensureSession(sessionKey, chatId, { resumeLast: false });
      await sendText(chatId, '已启动新的 Codex 会话。');
      if (payload) {
        session.writeUserText(payload);
      }
      return;
    }

    case '/resume-last': {
      stopSession(sessionKey, 'resuming last');
      savedSessionIds.delete(sessionKey);
      saveBridgeState();
      ensureSession(sessionKey, chatId, { resumeLast: true });
      await sendText(
        chatId,
        config.codexTransport === 'exec'
          ? '下一条普通消息会通过 codex exec resume --last 发送。'
          : '已执行 codex resume --last。',
      );
      return;
    }

    case '/stop':
      if (stopSession(sessionKey, 'stopped by user')) {
        await sendText(chatId, '已停止当前 Codex 会话。');
      } else {
        await sendText(chatId, '当前没有运行中的 Codex 会话。');
      }
      return;

    default:
      await sendText(chatId, `未知命令：${command}\n发送 /help 查看可用命令。`);
  }
}

function ensureSession(sessionKey, chatId, options) {
  const existing = sessions.get(sessionKey);
  if (existing && existing.isAlive()) {
    existing.touch();
    return existing;
  }

  const session =
    config.codexTransport === 'exec' || !pty
      ? new ExecCodexSessionV2(sessionKey, chatId, options)
      : new PtyCodexSession(sessionKey, chatId, options);
  sessions.set(sessionKey, session);
  session.start();
  return session;
}

function stopSession(sessionKey, reason) {
  const session = sessions.get(sessionKey);
  if (!session) {
    return false;
  }
  session.stop(reason);
  sessions.delete(sessionKey);
  return true;
}

function stopIdleSessions() {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (now - session.lastActivityAt > config.sessionIdleMs) {
      session.stop('idle timeout');
      sessions.delete(key);
    }
  }
}

class PtyCodexSession {
  constructor(sessionKey, chatId, options) {
    this.sessionKey = sessionKey;
    this.chatId = chatId;
    this.resumeLast = Boolean(options && options.resumeLast);
    this.cwd = getSelectedCwd(sessionKey);
    this.proc = null;
    this.running = false;
    this.buffer = '';
    this.flushTimer = null;
    this.lastActivityAt = Date.now();
    this.pipeMode = false;
  }

  start() {
    const args = buildCodexPtyArgs({ resumeLast: this.resumeLast, cwd: this.cwd });
    log('info', `starting codex for chat=${this.chatId}, cwd=${this.cwd}: ${config.codexCommand} ${args.join(' ')}`);

    if (pty) {
      this.proc = pty.spawn(config.codexCommand, args, {
        name: process.env.TERM || 'xterm-256color',
        cwd: this.cwd,
        cols: 120,
        rows: 36,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      });
      this.proc.onData((data) => this.onOutput(data));
      this.proc.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));
    } else {
      this.pipeMode = true;
      this.proc = spawn(config.codexCommand, args, {
        cwd: this.cwd,
        shell: true,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      });
      this.proc.stdout.on('data', (data) => this.onOutput(data.toString('utf8')));
      this.proc.stderr.on('data', (data) => this.onOutput(data.toString('utf8')));
      this.proc.on('exit', (code, signal) => this.onExit(code, signal));
      this.proc.on('error', (error) => this.onOutput(`Codex 启动失败：${error.message}\n`));
    }

    this.running = true;
    this.touch();
  }

  writeUserText(text) {
    if (!this.running || !this.proc) {
      return;
    }
    this.touch();

    if (this.pipeMode) {
      this.proc.stdin.write(`${text}\n`);
      return;
    }

    if (text.includes('\n')) {
      this.proc.write(`\x1b[200~${text}\x1b[201~\r`);
    } else {
      this.proc.write(`${text}\r`);
    }
  }

  onOutput(raw) {
    this.touch();
    const clean = normalizeTerminalOutput(raw);
    if (!clean.trim()) {
      return;
    }
    this.buffer += clean;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => log('error', 'failed to flush output', error));
    }, config.outputFlushMs);
  }

  async flush() {
    const text = this.buffer;
    this.buffer = '';
    const compact = compactOutput(text);
    if (!compact.trim()) {
      return;
    }
    await sendText(this.chatId, compact);
  }

  onExit(code, signal) {
    this.running = false;
    sessions.delete(this.sessionKey);
    const suffix = signal ? `signal=${signal}` : `code=${code}`;
    this.onOutput(`\n[Codex exited: ${suffix}]\n`);
  }

  stop(reason) {
    if (!this.proc) {
      return;
    }
    log('info', `stopping codex chat=${this.chatId}, reason=${reason}`);
    try {
      if (this.pipeMode) {
        this.proc.kill();
      } else {
        this.proc.kill();
      }
    } catch (error) {
      log('warn', `failed to stop process: ${error.message}`);
    }
    this.running = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  isAlive() {
    return this.running;
  }
}

class ExecCodexSession {
  constructor(sessionKey, chatId, options) {
    this.sessionKey = sessionKey;
    this.chatId = chatId;
    this.resumeLast = Boolean(options && options.resumeLast);
    this.cwd = getSelectedCwd(sessionKey);
    this.sessionId = this.resumeLast ? '' : savedSessionIds.get(sessionKey) || '';
    this.currentProc = null;
    this.stopped = false;
    this.lastActivityAt = Date.now();
  }

  start() {
    this.stopped = false;
    this.touch();
  }

  writeUserText(text) {
    if (this.stopped) {
      return;
    }
    if (this.currentProc) {
      void sendText(this.chatId, 'Codex 正在处理上一条消息，等它结束后再发下一条。');
      return;
    }

    this.touch();
    this.runPrompt(text).catch((error) => {
      this.currentProc = null;
      void sendText(this.chatId, `Codex 执行失败：${error.message}`);
    });
  }

  async runPrompt(prompt) {
    const outputFile = path.join(
      os.tmpdir(),
      `feishu-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    const args = buildCodexExecArgs({
      outputFile,
      sessionId: this.sessionId,
      resumeLast: this.resumeLast && !this.sessionId,
      cwd: this.cwd,
    });

    log('info', `running codex exec for chat=${this.chatId}, cwd=${this.cwd}: ${config.codexCommand} ${args.join(' ')}`);
    await sendText(this.chatId, 'Codex 已收到，开始处理。');

    const child = spawn(config.codexCommand, args, {
      cwd: this.cwd,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    this.currentProc = child;
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.stdin.end(prompt);

    const { code, signal } = await waitForExit(child);
    this.currentProc = null;
    this.touch();

    const discoveredSessionId = extractSessionId(stdout);
    if (discoveredSessionId) {
      this.setSessionId(discoveredSessionId);
    }

    const finalText = readIfExists(outputFile) || extractFinalText(stdout) || normalizeTerminalOutput(stdout);
    removeIfExists(outputFile);

    if (finalText.trim()) {
      await sendText(this.chatId, finalText.trim());
    }

    if (code !== 0 || signal) {
      const detail = stderr.trim() || `exit=${code}, signal=${signal || ''}`;
      await sendText(this.chatId, `Codex 进程异常结束：\n${normalizeTerminalOutput(detail).trim()}`);
    }
  }

  setSessionId(sessionId) {
    if (!sessionId || this.sessionId === sessionId) {
      return;
    }
    this.sessionId = sessionId;
    this.resumeLast = false;
    savedSessionIds.set(this.sessionKey, sessionId);
    saveBridgeState();
  }

  stop(reason) {
    log('info', `stopping exec session chat=${this.chatId}, reason=${reason}`);
    this.stopped = true;
    if (this.currentProc) {
      this.currentProc.kill();
      this.currentProc = null;
    }
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  isAlive() {
    return !this.stopped;
  }
}

class ExecCodexSessionV2 {
  constructor(sessionKey, chatId, options) {
    this.sessionKey = sessionKey;
    this.chatId = chatId;
    this.resumeLast = Boolean(options && options.resumeLast);
    this.cwd = getSelectedCwd(sessionKey);
    this.sessionId = this.resumeLast ? '' : savedSessionIds.get(sessionKey) || '';
    this.currentProc = null;
    this.currentStartedAt = 0;
    this.heartbeatTimer = null;
    this.timeoutTimer = null;
    this.streamRemainder = '';
    this.sentAgentTexts = new Set();
    this.lastEventType = '';
    this.imageBaseline = new Map();
    this.sentImages = new Set();
    this.stopped = false;
    this.lastActivityAt = Date.now();
  }

  start() {
    this.stopped = false;
    this.touch();
  }

  writeUserText(text) {
    if (this.stopped) {
      return;
    }
    if (this.currentProc) {
      void sendText(
        this.chatId,
        `Codex 正在处理上一条消息，已用时 ${formatElapsed(Date.now() - this.currentStartedAt)}。发送 /stop 可停止。`,
      );
      return;
    }

    this.touch();
    this.runPrompt(text).catch((error) => {
      this.currentProc = null;
      this.clearTimers();
      void sendText(this.chatId, `Codex failed: ${error.message}`);
    });
  }

  async runPrompt(prompt) {
    const outputFile = path.join(
      os.tmpdir(),
      `feishu-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    const args = buildCodexExecArgs({
      outputFile,
      sessionId: this.sessionId,
      resumeLast: this.resumeLast && !this.sessionId,
      cwd: this.cwd,
    });

    log('info', `running codex exec v2 for chat=${this.chatId}, cwd=${this.cwd}: ${config.codexCommand} ${args.join(' ')}`);
    if (config.showTurnProgress) {
      const action = this.sessionId || this.resumeLast ? '继续当前上下文' : '创建新的上下文';
      await sendText(this.chatId, `Codex 已收到，${action}。\n目录：${this.cwd}`);
    }

    const child = spawn(config.codexCommand, args, {
      cwd: this.cwd,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    this.currentProc = child;
    this.currentStartedAt = Date.now();
    this.streamRemainder = '';
    this.sentAgentTexts.clear();
    this.sentImages.clear();
    this.imageBaseline = snapshotImages(this.cwd);
    this.lastEventType = 'started';

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      stdout += chunk;
      void this.handleStdoutChunk(chunk);
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    this.startTimers(child);
    child.stdin.end(prompt);

    const { code, signal } = await waitForExit(child);
    this.currentProc = null;
    this.clearTimers();
    this.touch();
    await this.flushStreamRemainder();

    const discoveredSessionId = extractSessionId(stdout);
    if (discoveredSessionId) {
      this.sessionId = discoveredSessionId;
      this.resumeLast = false;
    }

    const finalText = readIfExists(outputFile) || extractFinalText(stdout);
    removeIfExists(outputFile);

    if (finalText.trim() && !this.sentAgentTexts.has(finalText.trim())) {
      this.sentAgentTexts.add(finalText.trim());
      await sendText(this.chatId, finalText.trim());
    }

    await this.sendGeneratedImages();

    if (code !== 0 || signal) {
      const detail = stderr.trim() || `exit=${code}, signal=${signal || ''}`;
      await sendText(this.chatId, `Codex process ended abnormally:\n${normalizeTerminalOutput(detail).trim()}`);
    } else if (!finalText.trim() && !this.sentAgentTexts.size) {
      await sendText(this.chatId, `Codex finished with no final text. Last event: ${this.lastEventType || 'unknown'}`);
    }
  }

  startTimers(child) {
    this.clearTimers();
    if (config.execHeartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (!this.currentProc) {
          return;
        }
        void sendText(
          this.chatId,
          `Codex 仍在处理，已用时 ${formatElapsed(Date.now() - this.currentStartedAt)}。最近事件：${this.lastEventType || 'started'}。发送 /stop 可停止。`,
        );
      }, config.execHeartbeatMs);
    }

    this.timeoutTimer = setTimeout(() => {
      if (!this.currentProc) {
        return;
      }
      void sendText(this.chatId, `Codex 超时：${formatElapsed(config.execTimeoutMs)}。正在停止进程。`);
      killProcessTree(child);
    }, config.execTimeoutMs);
  }

  clearTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  async handleStdoutChunk(chunk) {
    this.streamRemainder += chunk;
    const lines = this.streamRemainder.split(/\r?\n/);
    this.streamRemainder = lines.pop() || '';
    for (const line of lines) {
      await this.handleJsonLine(line);
    }
  }

  async flushStreamRemainder() {
    const tail = this.streamRemainder.trim();
    this.streamRemainder = '';
    if (tail) {
      await this.handleJsonLine(tail);
    }
  }

  async handleJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      log('debug', `non-json codex output: ${trimmed.slice(0, 200)}`);
      return;
    }

    this.lastEventType = event.type || this.lastEventType;
    const item = event.item || {};
    log('info', `codex event type=${event.type || ''}, item=${item.type || ''}`);
    const discoveredSessionId = extractSessionIdFromEvent(event);
    if (discoveredSessionId) {
      this.setSessionId(discoveredSessionId);
    }

    if (event.type === 'turn.started') {
      if (config.showCommandProgress) {
        await sendText(this.chatId, 'Codex turn started.');
      }
      return;
    }

    if (event.type === 'item.started' && item.type === 'command_execution') {
      if (config.showCommandProgress) {
        await sendText(this.chatId, `Codex is running command:\n${compactCommand(item.command)}`);
      }
      return;
    }

    if (event.type === 'item.completed' && item.type === 'command_execution') {
      if (config.showCommandProgress) {
        await sendText(this.chatId, `Codex command finished: ${item.status || 'unknown'}, exit=${item.exit_code ?? 'unknown'}\n${compactCommand(item.command)}`);
      } else if (item.exit_code !== 0) {
        await sendText(this.chatId, `Codex command failed: exit=${item.exit_code ?? 'unknown'}\n${compactCommand(item.command)}`);
      }
      return;
    }

    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      const text = item.text.trim();
      if (text && !this.sentAgentTexts.has(text)) {
        this.sentAgentTexts.add(text);
        await sendText(this.chatId, text);
      }
    }
  }

  async sendGeneratedImages() {
    if (!config.autoSendImages) {
      return;
    }

    const images = findNewImages(this.cwd, this.imageBaseline)
      .filter((image) => !this.sentImages.has(image.path))
      .slice(0, config.maxImagesPerRun);

    if (!images.length) {
      return;
    }

    await sendText(this.chatId, `Generated image${images.length > 1 ? 's' : ''}:`);
    for (const image of images) {
      this.sentImages.add(image.path);
      await sendImage(this.chatId, image.path);
    }
  }

  setSessionId(sessionId) {
    if (!sessionId || this.sessionId === sessionId) {
      return;
    }
    this.sessionId = sessionId;
    this.resumeLast = false;
    savedSessionIds.set(this.sessionKey, sessionId);
    saveBridgeState();
  }

  stop(reason) {
    log('info', `stopping exec v2 session chat=${this.chatId}, reason=${reason}`);
    this.stopped = true;
    if (this.currentProc) {
      killProcessTree(this.currentProc);
      this.currentProc = null;
    }
    this.clearTimers();
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  isAlive() {
    return !this.stopped;
  }
}

function buildCodexPtyArgs({ resumeLast, cwd }) {
  const args = [];
  args.push('--no-alt-screen');
  args.push('-C', cwd);

  if (config.codexModel) {
    args.push('-m', config.codexModel);
  }
  if (config.codexSandbox) {
    args.push('--sandbox', config.codexSandbox);
  }
  if (config.codexApproval) {
    args.push('--ask-for-approval', config.codexApproval);
  }
  if (config.codexEnableSearch) {
    args.push('--search');
  }
  args.push(...config.codexExtraArgs);

  if (resumeLast) {
    args.push('resume', '--last');
  }

  return args;
}

function buildCodexExecArgs({ outputFile, sessionId, resumeLast, cwd }) {
  if (sessionId || resumeLast) {
    const args = ['exec', 'resume', '--json', '-o', outputFile];
    if (config.codexModel) {
      args.push('-m', config.codexModel);
    }
    if (sessionId) {
      args.push(sessionId);
    } else {
      args.push('--last');
    }
    args.push('-');
    return args;
  }

  const args = ['exec', '--json', '--color', 'never', '-o', outputFile, '-C', cwd];
  if (!isGitRepo(cwd)) {
    args.push('--skip-git-repo-check');
  }
  if (config.codexModel) {
    args.push('-m', config.codexModel);
  }
  if (config.codexSandbox) {
    args.push('-s', config.codexSandbox);
  }
  args.push(...config.codexExtraArgs);
  args.push('-');
  return args;
}

function getSelectedCwd(sessionKey) {
  return selectedCwds.get(sessionKey) || config.defaultCodexCwd;
}

function loadBridgeState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const cwdEntries = Object.entries(raw.selectedCwds || {}).map(([key, value]) => [
      key,
      resolveInsideRoot(config.codexRoot, String(value)),
    ]);
    const sessionEntries = Object.entries(raw.sessionIds || {})
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([key, value]) => [key, value.trim()]);
    return {
      selectedCwds: new Map(cwdEntries),
      sessionIds: new Map(sessionEntries),
    };
  } catch {
    return {
      selectedCwds: new Map(),
      sessionIds: new Map(),
    };
  }
}

function saveBridgeState() {
  const selected = {};
  for (const [key, value] of selectedCwds.entries()) {
    selected[key] = value;
  }

  const sessionIds = {};
  for (const [key, value] of savedSessionIds.entries()) {
    sessionIds[key] = value;
  }

  fs.writeFileSync(statePath, JSON.stringify({ selectedCwds: selected, sessionIds }, null, 2));
}

function resolveUserPath(sessionKey, userPath) {
  try {
    return {
      ok: true,
      value: resolveInsideRoot(
        config.codexRoot,
        path.isAbsolute(userPath) ? userPath : path.join(getSelectedCwd(sessionKey), userPath),
      ),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function resolveInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }
  throw new Error(`Path is outside CODEX_ROOT:\n${resolvedCandidate}\nCODEX_ROOT=${resolvedRoot}`);
}

function formatDirectories(target) {
  if (!fs.existsSync(target)) {
    return `Directory does not exist:\n${target}`;
  }
  if (!fs.statSync(target).isDirectory()) {
    return `Not a directory:\n${target}`;
  }

  const directories = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (!directories.length) {
    return `No child directories.\n${target}`;
  }

  return [`Directories under ${target}:`, ...directories.map((name) => `- ${name}`)].join('\n');
}

function formatSessionStatus(session) {
  const lines = [
    session.currentProc ? 'Codex status: working' : 'Codex status: idle, context kept',
    `cwd=${session.cwd || getSelectedCwd(session.sessionKey)}`,
  ];

  if (session.sessionId) {
    lines.push(`thread_id=${session.sessionId}`);
  } else if (session.resumeLast) {
    lines.push('thread_id=resume --last on next prompt');
  } else if (!session.currentProc) {
    lines.push('thread_id=not created yet');
  }

  return lines.join('\n');
}

function isGitRepo(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function snapshotImages(root) {
  const snapshot = new Map();
  for (const image of listImages(root)) {
    snapshot.set(image.path, `${image.mtimeMs}:${image.size}`);
  }
  return snapshot;
}

function findNewImages(root, baseline) {
  return listImages(root)
    .filter((image) => {
      const key = `${image.mtimeMs}:${image.size}`;
      return baseline.get(image.path) !== key;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listImages(root) {
  const results = [];
  const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
  const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.wrangler']);
  const resolvedRoot = path.resolve(root);

  const walk = (dir, depth) => {
    if (depth > 6 || results.length > 2000) {
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile() || !imageExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.size <= 0 || stat.size > config.maxImageBytes) {
        continue;
      }

      if (!isPathInside(resolvedRoot, fullPath)) {
        continue;
      }

      results.push({
        path: fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };

  walk(resolvedRoot, 0);
  return results;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function helpText() {
  return [
    'cc commands:',
    '/help - show this command list',
    '/codex - how Codex CLI is used by this bot',
    '/examples - useful prompts to send to Codex',
    '/whoami - show Feishu ids for allow-list setup',
    '/status - show current Codex session status',
    '/pwd - show current Codex working directory',
    '/images - send recent images from the current project',
    '/dirs - list child directories',
    '/dirs <path> - list child directories under a path',
    '/cd <path> - switch Codex working directory under CODEX_ROOT',
    '/new - start a new Codex session in the selected directory',
    '/new <prompt> - start a new session and send the first prompt',
    '/resume-last - make the next prompt use codex resume --last',
    '/stop - stop the current Codex process',
    '',
    'Plain text after selecting a directory is sent to Codex.',
  ].join('\n');
}

function codexGuideText() {
  return [
    'How cc uses Codex CLI:',
    '1. Choose a project with /dirs and /cd.',
    '2. Send a normal message. The bridge runs codex exec in that directory.',
    '3. Follow-up messages reuse the saved Codex session id when possible.',
    '4. Use /new to start fresh, /stop to cancel, /pwd to confirm cwd.',
    '',
    'Current safety boundary:',
    `CODEX_ROOT=${config.codexRoot}`,
    '',
    'Good workflow:',
    '/dirs',
    '/cd demo-project',
    '/new Read this repo and tell me how to run it locally.',
    'Find the failing test and fix it.',
  ].join('\n');
}

function examplesText() {
  return [
    'Useful Codex prompts:',
    '- Read this project and summarize the architecture.',
    '- Find the bug in <feature> and fix it.',
    '- Run the tests for this repo and fix failures.',
    '- Add a small feature: <describe feature>.',
    '- Review the current git diff for bugs and risks.',
    '- Explain how to deploy this project.',
    '- Search for TODO/FIXME and prioritize what to fix.',
    '',
    'Directory commands:',
    '/dirs',
    '/cd <project>',
    '/pwd',
  ].join('\n');
}

function unauthorizedText(senderId, chatId) {
  return [
    'Not authorized. Codex CLI was not started.',
    '',
    'Add one of these ids to .env and restart bridge:',
    `open_id: ${senderId.open_id || '(empty)'}`,
    `user_id: ${senderId.user_id || '(empty)'}`,
    `union_id: ${senderId.union_id || '(empty)'}`,
    `chat_id: ${chatId || '(empty)'}`,
  ].join('\n');
}

async function sendText(chatId, text) {
  return sendTextToReceiveId('chat_id', chatId, text);
}

async function sendTextToOpenId(openId, text) {
  return sendTextToReceiveId('open_id', openId, text);
}

async function sendTextToReceiveId(receiveIdType, receiveId, text) {
  const usePost = shouldUsePost(text);
  const chunks = chunkText(text, usePost ? config.postChunkChars : config.outputChunkChars);
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }
    log('info', `sending ${usePost ? 'post' : 'text'} message to ${receiveIdType}=${receiveId}, chars=${chunk.length}`);
    const response = await createFeishuMessage({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: receiveId,
        content: usePost ? JSON.stringify(toFeishuPost(chunk)) : JSON.stringify({ text: safeFeishuText(chunk) }),
        msg_type: usePost ? 'post' : 'text',
      },
    });
    if (response && response.code !== undefined && response.code !== 0) {
      log('warn', `Feishu send returned code=${response.code}, msg=${response.msg || ''}`);
    }
    await sleep(250);
  }
}

async function sendImage(chatId, imagePath) {
  const relative = path.relative(config.codexRoot, imagePath) || path.basename(imagePath);
  try {
    const upload = await client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(imagePath),
      },
    });
    const imageKey = upload && (upload.image_key || (upload.data && upload.data.image_key));
    if (!imageKey) {
      throw new Error(`image_key missing in upload response: ${JSON.stringify(upload)}`);
    }

    await sendText(chatId, `Image: ${relative}`);
    const response = await createFeishuMessage({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      },
    });
    if (response && response.code !== undefined && response.code !== 0) {
      log('warn', `Feishu image send returned code=${response.code}, msg=${response.msg || ''}`);
    }
  } catch (error) {
    log('warn', `failed to send image ${imagePath}: ${error.message}`);
    await sendText(chatId, `Generated image exists, but upload failed:\n${imagePath}\n${error.message}`);
  }
}

async function createFeishuMessage(payload) {
  if (client.im && client.im.v1 && client.im.v1.message && client.im.v1.message.create) {
    return client.im.v1.message.create(payload);
  }
  return client.im.message.create(payload);
}

function extractText(content) {
  let parsed;
  try {
    parsed = JSON.parse(content || '{}');
  } catch {
    return '';
  }

  return String(parsed.text || '')
    .replace(/<at\b[^>]*>.*?<\/at>/g, '')
    .trim();
}

function isAllowed(senderId, chatId) {
  if (config.feishuAllowAll) {
    return true;
  }

  return (
    config.allowedOpenIds.has(senderId.open_id) ||
    config.allowedUserIds.has(senderId.user_id) ||
    config.allowedUnionIds.has(senderId.union_id) ||
    config.allowedChatIds.has(chatId)
  );
}

function shouldUsePost(text) {
  const value = String(text || '');
  return value.length > 240 || value.includes('\n') || value.includes('```') || /^\s*[-*]\s+/m.test(value) || /^\s*\d+\.\s+/m.test(value);
}

function toFeishuPost(text) {
  return {
    zh_cn: {
      title: 'Codex',
      content: markdownishToPostContent(text),
    },
  };
}

function markdownishToPostContent(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const content = [];
  let paragraph = [];
  let codeLines = [];
  let inCode = false;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    content.push(paragraphToElements(paragraph.join(' ')));
    paragraph = [];
  };

  const flushCode = () => {
    if (!codeLines.length) {
      return;
    }
    content.push([{ tag: 'text', text: codeLines.join('\n') }]);
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      content.push(paragraphToElements(heading[1]));
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      content.push(paragraphToElements(`• ${bullet[1]}`));
      continue;
    }

    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      content.push(paragraphToElements(`${numbered[1]}. ${numbered[2]}`));
      continue;
    }

    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();

  return content.length ? content : [[{ tag: 'text', text: String(text || '') }]];
}

function paragraphToElements(text) {
  return [{ tag: 'text', text: safeFeishuText(stripMarkdownForPost(text)) }];
}

function stripMarkdownForPost(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

function chunkText(text, maxChars) {
  const normalized = text.replace(/\r\n/g, '\n');
  const chunks = [];
  let rest = normalized;

  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.6)) {
      cut = maxChars;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  chunks.push(rest);
  return chunks;
}

function normalizeTerminalOutput(input) {
  return stripAnsi(String(input))
    .replace(/\x00/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[ \t]+\n/g, '\n');
}

function compactOutput(input) {
  const lines = input.split('\n');
  const compacted = [];
  for (const line of lines) {
    if (line.trim() === '' && compacted[compacted.length - 1] === '') {
      continue;
    }
    compacted.push(line);
  }
  return compacted.join('\n').trim();
}

function stripAnsi(input) {
  return input
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007/g, '')
    .replace(/.\x08/g, '');
}

function safeFeishuText(text) {
  return text.replace(/<at\b/gi, '< at');
}

function splitArgs(value) {
  if (!value.trim()) {
    return [];
  }
  return value.match(/(?:[^\s"]+|"[^"]*")+/g).map((part) => part.replace(/^"|"$/g, ''));
}

function normalizeTransport(value) {
  const requested = String(value || '').trim().toLowerCase();
  if (requested === 'pty' || requested === 'exec') {
    return requested;
  }
  return 'exec';
}

function requiredEnv(name) {
  const value = cleanEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function cleanEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function csvSet(name) {
  return new Set(
    (process.env[name] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function boolEnv(name, defaultValue) {
  const value = cleanEnv(name).toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'y', 'on'].includes(value);
}

function numberEnv(name, defaultValue) {
  const value = Number(cleanEnv(name));
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function nonNegativeNumberEnv(name, defaultValue) {
  const value = Number(cleanEnv(name));
  return Number.isFinite(value) && value >= 0 ? value : defaultValue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch (error) {
    log('warn', `failed to kill process: ${error.message}`);
  }
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function compactCommand(command) {
  const text = String(command || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '(unknown command)';
  }
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures for temp files.
  }
}

function extractSessionId(jsonl) {
  for (const event of parseJsonLines(jsonl)) {
    const id = extractSessionIdFromEvent(event);
    if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) {
      return id;
    }
  }
  return '';
}

function extractSessionIdFromEvent(event) {
  return (
    event.thread_id ||
    event.session_id ||
    event.sessionId ||
    (event.payload && (event.payload.thread_id || event.payload.session_id || event.payload.id)) ||
    ''
  );
}

function extractFinalText(jsonl) {
  let finalText = '';
  for (const event of parseJsonLines(jsonl)) {
    const candidates = [
      event.text,
      event.message,
      event.content,
      event.item && event.item.text,
      event.item && event.item.content,
      event.payload && event.payload.text,
      event.payload && event.payload.content,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        finalText = candidate;
      }
    }
  }
  return finalText;
}

function parseJsonLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function log(level, message, extra) {
  const levels = ['debug', 'info', 'warn', 'error'];
  if (levels.indexOf(level) < levels.indexOf(config.logLevel)) {
    return;
  }
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (extra) {
    console.error(line, extra);
  } else if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function shutdown() {
  for (const key of sessions.keys()) {
    stopSession(key, 'bridge shutdown');
  }
  process.exit(0);
}
