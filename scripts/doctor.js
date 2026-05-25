'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const isWindows = process.platform === 'win32';
const defaultCodexCommand = isWindows ? 'codex.cmd' : 'codex';
const codexCommand = process.env.CODEX_COMMAND || defaultCodexCommand;
const codexRoot = path.resolve(process.env.CODEX_ROOT || process.env.CODEX_CWD || process.cwd());
const codexCwd = path.resolve(process.env.CODEX_CWD || codexRoot);

const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || '').trim());
}

check('Node.js >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version);
check('.env exists', fs.existsSync(path.join(process.cwd(), '.env')), '.env is required for local credentials');
check('FEISHU_APP_ID set', hasEnv('FEISHU_APP_ID'), 'required');
check('FEISHU_APP_SECRET set', hasEnv('FEISHU_APP_SECRET'), 'required');
check('CODEX_ROOT exists', fs.existsSync(codexRoot), codexRoot);
check('CODEX_CWD exists', fs.existsSync(codexCwd), codexCwd);
check('CODEX_CWD inside CODEX_ROOT', isInside(codexRoot, codexCwd), `${codexCwd} inside ${codexRoot}`);

const codexVersion = spawnSync(codexCommand, ['--version'], {
  encoding: 'utf8',
  shell: isWindows,
});
check('Codex CLI available', codexVersion.status === 0, codexVersion.stdout.trim() || codexVersion.stderr.trim() || codexCommand);

let failed = 0;
for (const item of checks) {
  const marker = item.ok ? 'OK ' : 'ERR';
  if (!item.ok) {
    failed += 1;
  }
  console.log(`${marker} ${item.name} - ${item.detail}`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed. Fix the items above before starting the bridge.`);
  process.exit(1);
}

console.log('\nAll checks passed.');

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
