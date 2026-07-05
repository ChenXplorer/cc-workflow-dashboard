const assert = require('assert/strict');
const test = require('node:test');
const {
  argsForWorkflow,
  claudeEnvironment,
  claudeProjectSlug,
  extractTaskNotification,
  promptForSavedWorkflow,
  taskLaunchFromParsedMessage,
  taskLaunchFromText,
  textFromClaudeMessage
} = require('../src/lib/claude-runner');

test('textFromClaudeMessage extracts assistant text and tool events', () => {
  const text = textFromClaudeMessage({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'Read' }
      ]
    }
  });
  assert.match(text, /hello/);
  assert.match(text, /\[tool:Read\]/);
});

test('promptForSavedWorkflow invokes saved slash command with args', () => {
  assert.equal(
    promptForSavedWorkflow({ commandName: 'implement-and-verify' }, '修复测试'),
    '/implement-and-verify {"task":"修复测试"}'
  );
  assert.deepEqual(argsForWorkflow({ task: 'x', paths: ['src'] }), { task: 'x', paths: ['src'] });
});

test('claudeEnvironment maps DEEPSEEK_API_KEY to Claude Code Anthropic endpoint variables', () => {
  const env = claudeEnvironment({ DEEPSEEK_API_KEY: 'test-key' }, {});

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-key');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-flash');
});

test('task launch parser reads Claude Code workflow tool results', () => {
  assert.deepEqual(
    taskLaunchFromText('Task ID: task_123\nRun ID: wf_456\n'),
    { taskId: 'task_123', runId: 'wf_456' }
  );

  assert.deepEqual(
    taskLaunchFromParsedMessage({ toolUseResult: { taskId: 'task_json', runId: 'wf_json' } }),
    { taskId: 'task_json', runId: 'wf_json' }
  );

  assert.deepEqual(
    taskLaunchFromParsedMessage({
      message: {
        content: [
          { type: 'tool_result', content: 'Launched workflow\nTask ID: task_block\nRun ID: wf_block' }
        ]
      }
    }),
    { taskId: 'task_block', runId: 'wf_block' }
  );
});

test('extractTaskNotification reads Claude Code workflow completion events', () => {
  const notification = extractTaskNotification(JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: '<task-notification><task-id>abc</task-id><status>completed</status><summary>done</summary><result>&quot;OK&quot;</result></task-notification>'
  }));

  assert.equal(notification.taskId, 'abc');
  assert.equal(notification.status, 'completed');
  assert.equal(notification.result, '"OK"');
});

test('claudeProjectSlug matches Claude Code project transcript folder naming', () => {
  assert.equal(
    claudeProjectSlug('C:\\Users\\example\\AppData\\Local\\Temp\\demo'),
    'C--Users-example-AppData-Local-Temp-demo'
  );
});
