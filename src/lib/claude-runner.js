const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fsp = require('fs/promises');
const { claudeRuntimeEnvironment, resolveClaudeCommand, useShellForCommand } = require('./claude-config');

function textFromClaudeMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'result') return message.result || '';
  if (message.type === 'assistant' && message.message?.content) {
    const chunks = [];
    for (const block of message.message.content) {
      if (block.type === 'text') chunks.push(block.text || '');
      if (block.type === 'tool_use') chunks.push(`\n[tool:${block.name || 'unknown'}]\n`);
    }
    return chunks.join('');
  }
  if (message.type === 'system' && message.subtype) {
    return `\n[system:${message.subtype}]\n`;
  }
  return '';
}

function taskLaunchFromParsedMessage(message) {
  if (!message || typeof message !== 'object') return { taskId: '', runId: '' };
  if (message.toolUseResult?.taskId) {
    return {
      taskId: message.toolUseResult.taskId,
      runId: message.toolUseResult.runId || ''
    };
  }

  const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
  for (const block of blocks) {
    if (block.type === 'tool_result' && typeof block.content === 'string') {
      const launch = taskLaunchFromText(block.content);
      if (launch.taskId || launch.runId) return launch;
    }
  }

  return { taskId: '', runId: '' };
}

function argsForWorkflow(input) {
  return typeof input === 'object' && input !== null ? input : { task: String(input || '') };
}

function promptForSavedWorkflow(workflow, input) {
  return `/${workflow.commandName} ${JSON.stringify(argsForWorkflow(input))}`;
}

function claudeEnvironment(baseEnv = process.env, storedEnv) {
  const env = claudeRuntimeEnvironment(baseEnv, storedEnv);
  if (env.DEEPSEEK_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_BASE_URL ||= 'https://api.deepseek.com/anthropic';
    env.ANTHROPIC_AUTH_TOKEN = env.DEEPSEEK_API_KEY;
    env.ANTHROPIC_MODEL ||= 'deepseek-v4-pro[1m]';
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||= 'deepseek-v4-pro[1m]';
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||= 'deepseek-v4-pro[1m]';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||= 'deepseek-v4-flash';
    env.CLAUDE_CODE_SUBAGENT_MODEL ||= 'deepseek-v4-flash';
    env.CLAUDE_CODE_EFFORT_LEVEL ||= 'max';
  }
  return env;
}

function claudeProjectSlug(projectRoot) {
  return path.resolve(projectRoot)
    .replace(/[:\\/]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function transcriptFile(projectRoot, sessionId) {
  return path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.claude',
    'projects',
    claudeProjectSlug(projectRoot),
    `${sessionId}.jsonl`
  );
}

function extractTag(value, tag) {
  const match = String(value || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : '';
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function extractTaskNotification(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const content = event.content || event.message?.content;
  if (typeof content !== 'string' || !content.includes('<task-notification>')) return null;
  return {
    taskId: extractTag(content, 'task-id'),
    status: extractTag(content, 'status'),
    summary: decodeXmlText(extractTag(content, 'summary')),
    result: decodeXmlText(extractTag(content, 'result')),
    outputFile: decodeXmlText(extractTag(content, 'output-file')),
    raw: content
  };
}

async function readTaskNotification(file, taskId) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const notifications = raw
    .split(/\r?\n/)
    .map(extractTaskNotification)
    .filter(Boolean)
    .filter((notification) => !taskId || notification.taskId === taskId);
  return notifications.at(-1) || null;
}

async function waitForTaskNotification(file, taskId, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const notification = await readTaskNotification(file, taskId);
    if (notification?.status === 'completed' || notification?.status === 'failed') return notification;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return null;
}

function taskLaunchFromText(text) {
  const taskId = String(text || '').match(/Task ID:\s*([^\s]+)/)?.[1] || '';
  const runId = String(text || '').match(/Run ID:\s*([^\s]+)/)?.[1] || '';
  return { taskId, runId };
}

class ClaudeRunner extends EventEmitter {
  constructor(options) {
    super();
    this.projectRoot = options.projectRoot;
    this.appRoot = options.appRoot;
    this.processes = new Map();
  }

  stopRun(runId) {
    for (const [key, child] of this.processes.entries()) {
      if (key.startsWith(`${runId}:`)) {
        child.kill('SIGTERM');
        this.processes.delete(key);
      }
    }
  }

  async runSavedWorkflow({ runId, workflow, input }) {
    const prompt = promptForSavedWorkflow(workflow, input);

    return this.runClaudePrint({
      runId,
      nodeId: workflow.commandName,
      prompt,
      waitForWorkflow: true
    });
  }

  async runClaudePrint({ runId, nodeId, prompt, waitForWorkflow = false }) {
    const env = claudeEnvironment(process.env);
    const resolved = resolveClaudeCommand(this.appRoot, env);
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      process.env.ULTRACODE_PERMISSION_MODE || 'bypassPermissions'
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(resolved.command, args, {
        cwd: this.projectRoot,
        shell: useShellForCommand(resolved.command),
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true
      });
      const key = `${runId}:${nodeId}`;
      this.processes.set(key, child);
      let output = '';
      let stderr = '';
      let buffer = '';
      let sessionId = '';
      let taskId = '';

      child.stdin.write(prompt);
      child.stdin.end();

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let text = '';
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
              sessionId = parsed.session_id;
            }
            const launchFromJson = taskLaunchFromParsedMessage(parsed);
            if (launchFromJson.taskId) taskId = launchFromJson.taskId;
            text = textFromClaudeMessage(parsed);
          } catch {
            text = `${trimmed}\n`;
          }
          if (text) {
            output += text;
            const launch = taskLaunchFromText(text);
            if (launch.taskId) taskId = launch.taskId;
            this.emit('chunk', { runId, nodeId, stream: 'stdout', text });
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        this.emit('chunk', { runId, nodeId, stream: 'stderr', text });
      });

      child.on('error', (error) => {
        this.processes.delete(key);
        reject(error);
      });

      child.on('close', async (code) => {
        this.processes.delete(key);
        const pending = buffer.trim();
        if (pending) {
          let text = '';
          try {
            const parsed = JSON.parse(pending);
            const launchFromJson = taskLaunchFromParsedMessage(parsed);
            if (launchFromJson.taskId) taskId = launchFromJson.taskId;
            text = textFromClaudeMessage(parsed);
          } catch {
            text = `${pending}\n`;
          }
          output += text;
          const launch = taskLaunchFromText(text);
          if (launch.taskId) taskId = launch.taskId;
        }
        try {
          if (sessionId && waitForWorkflow) {
            const file = transcriptFile(this.projectRoot, sessionId);
            const notification = await waitForTaskNotification(file, taskId);
            if (notification?.result) {
              this.emit('chunk', { runId, nodeId, stream: 'stdout', text: `\n${notification.summary}\n${notification.result}\n` });
            }
            if (notification?.status === 'completed') {
              resolve(notification.result || output);
              return;
            }
            if (notification?.status === 'failed') {
              reject(new Error(notification.result || notification.summary || 'Workflow failed'));
              return;
            }
          }
          if (code === 0) resolve(output);
          else reject(new Error(stderr.trim() || output.trim() || `Claude Code exited with code ${code}`));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

module.exports = {
  argsForWorkflow,
  claudeEnvironment,
  claudeProjectSlug,
  extractTaskNotification,
  promptForSavedWorkflow,
  taskLaunchFromParsedMessage,
  taskLaunchFromText,
  transcriptFile,
  ClaudeRunner,
  textFromClaudeMessage
};
