'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCodexErrorText,
  formatCodexFailure,
  sanitizeCodexStderr,
  splitCodexLogLines,
} = require('../src/codex-output');

test('splitCodexLogLines separates adjacent timestamped codex logs', () => {
  const input =
    "2026-05-25T08:26:14.707052Z WARN codex_core_skills::loader: ignoring interface.icon_large: icon path must not contain '..' 2026-05-25T08:26:16.706194Z ERROR codex_core::util: Invalid image detected; sanitizing tool output to prevent poisoning";

  assert.deepEqual(splitCodexLogLines(input), [
    "2026-05-25T08:26:14.707052Z WARN codex_core_skills::loader: ignoring interface.icon_large: icon path must not contain '..'",
    '2026-05-25T08:26:16.706194Z ERROR codex_core::util: Invalid image detected; sanitizing tool output to prevent poisoning',
  ]);
});

test('sanitizeCodexStderr removes skill icon warnings but preserves useful errors', () => {
  const input =
    "2026-05-25T08:26:14.707052Z WARN codex_core_skills::loader: ignoring interface.icon_large: icon path must not contain '..' 2026-05-25T08:26:14.709802Z WARN codex_core_skills::loader: ignoring interface.icon_small: icon path must not contain '..' 2026-05-25T08:26:16.706194Z ERROR codex_core::util: Invalid image detected; sanitizing tool output to prevent poisoning";

  assert.equal(
    sanitizeCodexStderr(input),
    'Invalid image detected; sanitizing tool output to prevent poisoning',
  );
});

test('extractCodexErrorText accepts common codex json event shapes', () => {
  assert.equal(extractCodexErrorText({ type: 'error', message: 'boom' }), 'boom');
  assert.equal(extractCodexErrorText({ type: 'turn.failed', payload: { error: 'bad turn' } }), 'bad turn');
  assert.equal(extractCodexErrorText({ type: 'error', item: { detail: 'bad item' } }), 'bad item');
});

test('formatCodexFailure humanizes invalid image errors', () => {
  const message = formatCodexFailure({
    stderr: 'ERROR codex_core::util: Invalid image detected; sanitizing tool output to prevent poisoning',
    code: 1,
    signal: null,
    lastEventType: 'turn.failed',
  });

  assert.match(message, /Codex 这轮没有生成正常回答/);
  assert.match(message, /检测到无效图片/);
  assert.match(message, /\/new/);
  assert.doesNotMatch(message, /codex_core_skills/);
});
