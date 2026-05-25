'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachmentExtensionFromHeaders,
  buildAttachmentPath,
  extractImageKey,
} = require('../src/feishu-images');

test('extractImageKey reads image_key from Feishu image content', () => {
  assert.equal(extractImageKey('{"image_key":"img_v3_abc"}'), 'img_v3_abc');
});

test('extractImageKey accepts file_key fallback', () => {
  assert.equal(extractImageKey('{"file_key":"file_abc"}'), 'file_abc');
});

test('extractImageKey returns empty string for invalid content', () => {
  assert.equal(extractImageKey('{bad json'), '');
});

test('attachmentExtensionFromHeaders maps image content types', () => {
  assert.equal(attachmentExtensionFromHeaders({ 'content-type': 'image/jpeg; charset=binary' }), '.jpg');
  assert.equal(attachmentExtensionFromHeaders({ 'Content-Type': 'image/webp' }), '.webp');
  assert.equal(attachmentExtensionFromHeaders({}), '.png');
});

test('buildAttachmentPath keeps files under the selected cwd inbox', () => {
  const cwd = path.resolve('/workspace/project');
  const filePath = buildAttachmentPath({
    cwd,
    messageId: 'om_abc/with bad chars',
    imageKey: 'img_v3_secret+key',
    extension: '.jpg',
  });

  assert.equal(path.dirname(path.dirname(filePath)), path.join(cwd, '.codex-inbox'));
  assert.equal(path.extname(filePath), '.jpg');
  assert.match(path.basename(filePath), /om_abc_with_bad_chars/);
});
