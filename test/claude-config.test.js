const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  authEnvSummary,
  claudeRuntimeEnvironment,
  resolveClaudeCommand,
  useShellForCommand
} = require('../src/lib/claude-config');

function localClaudeBin(appRoot) {
  if (process.platform === 'win32') {
    return path.join(appRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  return path.join(appRoot, 'node_modules', '.bin', 'claude');
}

function commandName() {
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

function writeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
}

test('useShellForCommand only shells Windows shim commands', () => {
  if (process.platform === 'win32') {
    assert.equal(useShellForCommand('claude'), true);
    assert.equal(useShellForCommand('C:\\tools\\claude.cmd'), true);
    assert.equal(useShellForCommand('C:\\tools\\claude.exe'), false);
  } else {
    assert.equal(useShellForCommand('claude'), false);
    assert.equal(useShellForCommand('/usr/local/bin/claude'), false);
  }
});

test('authEnvSummary treats DeepSeek key as runnable Claude Code auth', () => {
  assert.deepEqual(authEnvSummary({ DEEPSEEK_API_KEY: 'x' }), {
    hasAnthropicApiKey: false,
    hasAnthropicAuthToken: false,
    hasAnthropicBaseUrl: false,
    hasDeepseekApiKey: true,
    hasRunnableAuth: true,
    provider: 'deepseek'
  });

  assert.equal(authEnvSummary({ ANTHROPIC_AUTH_TOKEN: 'x' }).provider, 'anthropic-compatible');
});

test('claudeRuntimeEnvironment fills missing Claude auth keys from stored environment', () => {
  const env = claudeRuntimeEnvironment(
    { PATH: 'test-path' },
    {
      ANTHROPIC_AUTH_TOKEN: 'stored-token',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]'
    }
  );

  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'stored-token');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(env.PATH, 'test-path');
});

test('claudeRuntimeEnvironment keeps process values over stored environment', () => {
  const env = claudeRuntimeEnvironment(
    { ANTHROPIC_AUTH_TOKEN: 'process-token' },
    { ANTHROPIC_AUTH_TOKEN: 'stored-token' }
  );

  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'process-token');
});

test('resolveClaudeCommand prefers CLAUDE_BIN override', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  assert.deepEqual(
    resolveClaudeCommand(appRoot, { CLAUDE_BIN: '/custom/claude', PATH: '' }),
    { command: '/custom/claude', source: 'CLAUDE_BIN' }
  );
});

test('resolveClaudeCommand prefers global PATH claude over project dependency', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  const appRoot = path.join(root, 'app');
  const globalBin = path.join(root, 'global-bin');
  const localBin = path.join(appRoot, 'node_modules', '.bin', commandName());
  const globalCommand = path.join(globalBin, commandName());

  writeExecutable(localBin);
  writeExecutable(localClaudeBin(appRoot));
  writeExecutable(globalCommand);

  const env = {
    PATH: [path.dirname(localBin), globalBin].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD'
  };

  assert.deepEqual(
    resolveClaudeCommand(appRoot, env),
    { command: globalCommand, source: 'path' }
  );
});

test('resolveClaudeCommand falls back to project dependency when PATH has no claude', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  const local = localClaudeBin(appRoot);

  writeExecutable(local);

  assert.deepEqual(
    resolveClaudeCommand(appRoot, { PATH: '' }),
    { command: local, source: 'local-dependency' }
  );
});
