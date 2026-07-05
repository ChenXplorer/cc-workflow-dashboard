const assert = require('assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const test = require('node:test');
const { startDashboard } = require('../src/server');
const {
  DEFAULT_PORT_BASE,
  DEFAULT_PORT_SPAN,
  mountPathForBasePath,
  normalizeBasePath,
  projectDashboardDefaults,
  projectInstanceKey,
  wsPathForBasePath
} = require('../src/lib/project-instance');

async function tmpProject() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ultracode-project-'));
}

test('project dashboard defaults are stable and project-scoped', () => {
  const first = path.join(os.tmpdir(), 'example-one');
  const second = path.join(os.tmpdir(), 'example-two');
  const firstDefaults = projectDashboardDefaults(first);
  const firstAgain = projectDashboardDefaults(first);
  const secondDefaults = projectDashboardDefaults(second);

  assert.deepEqual(firstDefaults, firstAgain);
  assert.notEqual(projectInstanceKey(first), projectInstanceKey(second));
  assert.match(firstDefaults.projectKey, /^example-one-[a-f0-9]{8}$/);
  assert.equal(firstDefaults.basePath, `/ultracode/${firstDefaults.projectKey}/`);
  assert.equal(firstDefaults.port >= DEFAULT_PORT_BASE, true);
  assert.equal(firstDefaults.port < DEFAULT_PORT_BASE + DEFAULT_PORT_SPAN, true);
});

test('base path helpers normalize route and websocket paths', () => {
  assert.equal(normalizeBasePath('ultracode/demo'), '/ultracode/demo/');
  assert.equal(normalizeBasePath('/ultracode/demo'), '/ultracode/demo/');
  assert.equal(normalizeBasePath('/'), '/');
  assert.equal(mountPathForBasePath('/ultracode/demo/'), '/ultracode/demo');
  assert.equal(wsPathForBasePath('/ultracode/demo/'), '/ultracode/demo/ws');
  assert.equal(wsPathForBasePath('/'), '/ws');
});

test('dashboard routes are isolated under the project base path', async () => {
  const projectRoot = await tmpProject();
  const appRoot = path.resolve(__dirname, '..');
  const dashboard = await startDashboard({
    projectRoot,
    appRoot,
    projectKey: 'test-project',
    host: '127.0.0.1',
    port: 6200,
    basePath: '/ultracode/test-project/'
  });

  try {
    const origin = `http://${dashboard.host}:${dashboard.port}`;
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/ultracode/test-project/');

    const index = await fetch(`${origin}/ultracode/test-project/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /"\/ultracode\/test-project\/"/);

    const rootApi = await fetch(`${origin}/api/workflows`);
    assert.equal(rootApi.status, 404);

    const scopedApi = await fetch(`${origin}/ultracode/test-project/api/workflows`);
    assert.equal(scopedApi.status, 200);
    assert.deepEqual(await scopedApi.json(), { workflows: [] });
  } finally {
    await dashboard.close();
  }
});
