'use strict';

const ISO_LOG_PREFIX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/g;

function extractCodexErrorText(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const candidates = [
    event.message,
    event.error,
    event.detail,
    event.reason,
    event.payload && event.payload.message,
    event.payload && event.payload.error,
    event.payload && event.payload.detail,
    event.item && event.item.message,
    event.item && event.item.error,
    event.item && event.item.detail,
  ];

  for (const candidate of candidates) {
    const text = stringifyErrorCandidate(candidate);
    if (text) {
      return text;
    }
  }

  return '';
}

function sanitizeCodexStderr(stderr) {
  const lines = splitCodexLogLines(stderr);
  const kept = [];

  for (const line of lines) {
    const cleaned = cleanCodexLogLine(line);
    if (!cleaned || isNoisyCodexLog(cleaned)) {
      continue;
    }
    kept.push(cleaned);
  }

  return dedupeLines(kept).join('\n').trim();
}

function formatCodexFailure({ errorText, stderr, code, signal, lastEventType }) {
  const known = humanizeKnownCodexError(errorText || sanitizeCodexStderr(stderr));
  const fallback = known || `Codex 进程退出异常，exit=${code ?? 'unknown'}${signal ? `, signal=${signal}` : ''}`;
  const details = truncateForChat(fallback, 1600);
  const suffix = lastEventType ? `\n最近事件：${lastEventType}` : '';

  return [
    'Codex 这轮没有生成正常回答。',
    '',
    details,
    suffix.trim(),
    '',
    '可以直接重发问题；如果你刚让它处理图片，建议先让它只输出文字，或换一张正常的 PNG/JPG 再试。',
  ]
    .filter(Boolean)
    .join('\n');
}

function splitCodexLogLines(text) {
  return String(text || '')
    .replace(ISO_LOG_PREFIX, (match, offset) => (offset === 0 ? match : `\n${match}`))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanCodexLogLine(line) {
  return String(line || '')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, '')
    .replace(/^(WARN|INFO|DEBUG|ERROR)\s+/, '')
    .replace(/^codex_core[^\s:]*::[^\s:]+:\s*/, '')
    .trim();
}

function isNoisyCodexLog(line) {
  return (
    /codex_core_skills::loader: ignoring interface\.icon_/i.test(line) ||
    /ignoring interface\.icon_.*icon path must not contain/i.test(line) ||
    /^thread\.started$/i.test(line) ||
    /^turn\.started$/i.test(line)
  );
}

function humanizeKnownCodexError(text) {
  const value = String(text || '').trim();
  if (!value) {
    return '';
  }

  if (/invalid image detected/i.test(value)) {
    return 'Codex 检测到无效图片并中止了这轮输出。这通常是某个工具输出或项目里的图片文件不符合 Codex 的图片安全校验。';
  }

  return value;
}

function stringifyErrorCandidate(candidate) {
  if (!candidate) {
    return '';
  }
  if (typeof candidate === 'string') {
    return candidate.trim();
  }
  if (candidate instanceof Error) {
    return candidate.message.trim();
  }
  if (typeof candidate === 'object') {
    return String(candidate.message || candidate.error || candidate.detail || candidate.reason || '').trim();
  }
  return String(candidate).trim();
}

function dedupeLines(lines) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    result.push(line);
  }
  return result;
}

function truncateForChat(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 20).trim()}\n...已截断`;
}

module.exports = {
  extractCodexErrorText,
  formatCodexFailure,
  sanitizeCodexStderr,
  splitCodexLogLines,
};
