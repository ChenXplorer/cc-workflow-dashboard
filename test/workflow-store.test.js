const assert = require('assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const test = require('node:test');
const { WorkflowStore } = require('../src/lib/workflow-store');

async function tmpProject() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'workflow-store-'));
}

test('WorkflowStore.load does not create a default workflow in empty projects', async () => {
  const root = await tmpProject();
  const store = new WorkflowStore(root);
  const workflows = await store.load();

  assert.deepEqual(workflows, []);
  await assert.rejects(
    fsp.access(path.join(root, '.claude', 'workflows')),
    /ENOENT/
  );
});

test('WorkflowStore.create writes a minimal official workflow on demand', async () => {
  const root = await tmpProject();
  const store = new WorkflowStore(root);
  await store.load();

  const workflow = await store.create({ commandName: 'manual-flow', name: '手动创建' });

  assert.equal(workflow.commandName, 'manual-flow');
  assert.match(workflow.file, /[\\/]\.claude[\\/]workflows[\\/]manual-flow\.js$/);
  assert.equal(workflow.nodes.some((node) => node.type === 'start'), true);
  assert.equal(workflow.nodes.some((node) => node.type === 'end'), true);
});
