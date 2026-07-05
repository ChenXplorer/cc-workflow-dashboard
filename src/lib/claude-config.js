const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { claudeDir, userClaudeDir } = require('./paths');

const CLAUDE_ENV_KEYS = [
  'CLAUDE_BIN',
  'CLAUDE_CONFIG_DIR',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL'
];

function localClaudeBin(appRoot) {
  if (process.platform === 'win32') {
    return path.join(appRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  return path.join(appRoot, 'node_modules', '.bin', 'claude');
}

function fileExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function envValue(env, key) {
  const actualKey = Object.keys(env || {}).find((name) => name.toLowerCase() === key.toLowerCase());
  return actualKey ? env[actualKey] : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readWindowsEnvValue(scope, name) {
  if (process.platform !== 'win32') return '';

  const roots = {
    User: 'HKCU\\Environment',
    Machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  };
  const root = roots[scope];
  if (!root) return '';

  try {
    const output = execFileSync('reg', ['query', root, '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+([\\s\\S]*)$`, 'i');
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
  } catch {
    return '';
  }

  return '';
}

function storedClaudeEnvironment() {
  if (process.platform !== 'win32') return {};

  const env = {};
  for (const scope of ['Machine', 'User']) {
    for (const key of CLAUDE_ENV_KEYS) {
      const value = readWindowsEnvValue(scope, key);
      if (value) env[key] = value;
    }
  }
  return env;
}

function claudeRuntimeEnvironment(baseEnv = process.env, storedEnv = storedClaudeEnvironment()) {
  const env = { ...baseEnv };

  for (const key of CLAUDE_ENV_KEYS) {
    const storedValue = envValue(storedEnv, key);
    if (storedValue && !envValue(env, key)) {
      env[key] = storedValue;
    }
  }

  return env;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function commandCandidates(command, env = process.env) {
  if (process.platform !== 'win32' || path.extname(command)) return [command];

  const pathext = envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  const extensions = pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => ext.startsWith('.') ? ext : `.${ext}`);

  return [...extensions.map((ext) => `${command}${ext}`), command];
}

function resolveCommandOnPath(command, env = process.env, { excludeUnder } = {}) {
  if (/[\\/]/.test(command)) return isExecutable(command) ? command : '';

  const pathValue = envValue(env, 'PATH');
  const entries = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const excludedRoot = excludeUnder ? path.resolve(excludeUnder) : '';

  for (const entry of entries) {
    for (const candidate of commandCandidates(command, env)) {
      const file = path.join(entry, candidate);
      if (excludedRoot && isPathInside(file, excludedRoot)) continue;
      if (isExecutable(file)) {
        try {
          return fs.realpathSync.native(file);
        } catch {
          return file;
        }
      }
    }
  }

  return '';
}

function resolveClaudeCommand(appRoot, env = process.env) {
  const claudeBin = envValue(env, 'CLAUDE_BIN');
  if (claudeBin) {
    return { command: claudeBin, source: 'CLAUDE_BIN' };
  }

  const globalCommand = resolveCommandOnPath('claude', env, {
    excludeUnder: path.join(appRoot, 'node_modules')
  });
  if (globalCommand) {
    return { command: globalCommand, source: 'path' };
  }

  const local = localClaudeBin(appRoot);
  if (fileExists(local)) {
    return { command: local, source: 'local-dependency' };
  }

  return { command: 'claude', source: 'path' };
}

function useShellForCommand(command) {
  if (process.platform !== 'win32') return false;
  return !/\.(exe|com)$/i.test(String(command || ''));
}

function runForOutput(command, args, cwd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: useShellForCommand(command),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function statSummary(file) {
  try {
    const stat = fs.statSync(file);
    return {
      exists: true,
      path: file,
      updatedAt: stat.mtime.toISOString()
    };
  } catch {
    return { exists: false, path: file };
  }
}

function safeSettingsKeys(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.keys(json).filter((key) => !/key|token|secret|password/i.test(key));
  } catch {
    return [];
  }
}

function authEnvSummary(env = process.env) {
  const hasAnthropicApiKey = Boolean(envValue(env, 'ANTHROPIC_API_KEY'));
  const hasAnthropicAuthToken = Boolean(envValue(env, 'ANTHROPIC_AUTH_TOKEN'));
  const hasAnthropicBaseUrl = Boolean(envValue(env, 'ANTHROPIC_BASE_URL'));
  const hasDeepseekApiKey = Boolean(envValue(env, 'DEEPSEEK_API_KEY'));
  return {
    hasAnthropicApiKey,
    hasAnthropicAuthToken,
    hasAnthropicBaseUrl,
    hasDeepseekApiKey,
    hasRunnableAuth: hasAnthropicApiKey || hasAnthropicAuthToken || hasDeepseekApiKey,
    provider: hasDeepseekApiKey && !hasAnthropicApiKey && !hasAnthropicAuthToken
      ? 'deepseek'
      : 'anthropic-compatible'
  };
}

async function getClaudeStatus(projectRoot, appRoot) {
  const env = claudeRuntimeEnvironment(process.env);
  const resolved = resolveClaudeCommand(appRoot, env);
  const version = await runForOutput(resolved.command, ['--version'], projectRoot, 6000);
  const userDir = userClaudeDir();
  const projectDir = claudeDir(projectRoot);
  const userSettings = path.join(userDir, 'settings.json');
  const projectSettings = path.join(projectDir, 'settings.json');
  const localSettings = path.join(projectDir, 'settings.local.json');

  return {
    command: resolved.command,
    commandSource: resolved.source,
    installed: version.ok,
    version: version.ok ? version.stdout.trim() || version.stderr.trim() : null,
    error: version.ok ? null : version.stderr.trim(),
    authEnv: authEnvSummary(env),
    config: {
      userSettings: {
        ...statSummary(userSettings),
        keys: safeSettingsKeys(userSettings)
      },
      projectSettings: {
        ...statSummary(projectSettings),
        keys: safeSettingsKeys(projectSettings)
      },
      localSettings: {
        ...statSummary(localSettings),
        keys: safeSettingsKeys(localSettings)
      },
      userAgents: statSummary(path.join(userDir, 'agents')),
      projectAgents: statSummary(path.join(projectDir, 'agents')),
      projectSkills: statSummary(path.join(projectDir, 'skills')),
      projectCommands: statSummary(path.join(projectDir, 'commands')),
      projectWorkflows: statSummary(path.join(projectDir, 'workflows'))
    }
  };
}

module.exports = {
  authEnvSummary,
  claudeRuntimeEnvironment,
  getClaudeStatus,
  resolveClaudeCommand,
  runForOutput,
  storedClaudeEnvironment,
  useShellForCommand
};
