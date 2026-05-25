'use strict';

const path = require('node:path');

const IMAGE_EXTENSION_BY_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
]);

function extractImageKey(content) {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    return '';
  }

  return String(parsed.image_key || parsed.file_key || '').trim();
}

function attachmentExtensionFromHeaders(headers) {
  const contentType = headerValue(headers, 'content-type').split(';')[0].trim().toLowerCase();
  return IMAGE_EXTENSION_BY_MIME.get(contentType) || '.png';
}

function buildAttachmentPath({ cwd, messageId, imageKey, extension }) {
  const safeMessageId = safeNamePart(messageId || 'message');
  const safeImageKey = safeNamePart(imageKey || 'image').slice(0, 48);
  const ext = normalizeExtension(extension);
  return path.join(cwd, '.codex-inbox', 'feishu-images', `${Date.now()}-${safeMessageId}-${safeImageKey}${ext}`);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowerName);
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function safeNamePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';
}

function normalizeExtension(extension) {
  const value = String(extension || '').toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(value)) {
    return value;
  }
  return '.png';
}

module.exports = {
  attachmentExtensionFromHeaders,
  buildAttachmentPath,
  extractImageKey,
};
