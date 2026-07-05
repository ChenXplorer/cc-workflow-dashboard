const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { findOpenPort } = require('./lib/ports');
const { WorkflowStore } = require('./lib/workflow-store');
const { WorkflowEngine } = require('./lib/workflow-engine');
const { WsHub } = require('./lib/ws-hub');
const { getClaudeStatus } = require('./lib/claude-config');
const {
  mountPathForBasePath,
  normalizeBasePath,
  wsPathForBasePath
} = require('./lib/project-instance');

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function renderIndexHtml(appRoot, basePath) {
  const file = path.join(appRoot, 'public', 'index.html');
  return fs.readFileSync(file, 'utf8')
    .replace('"__ULTRACODE_BASE_PATH__"', JSON.stringify(basePath));
}

function createApp(options) {
  const app = express();
  const router = express.Router();
  const basePath = normalizeBasePath(options.basePath || '/');
  const mountPath = mountPathForBasePath(basePath);
  const wsPath = wsPathForBasePath(basePath);
  const store = new WorkflowStore(options.projectRoot);
  const engine = new WorkflowEngine(options);

  app.locals.store = store;
  app.locals.engine = engine;
  app.locals.projectRoot = options.projectRoot;
  app.locals.appRoot = options.appRoot;
  app.locals.projectKey = options.projectKey || '';
  app.locals.basePath = basePath;
  app.locals.wsPath = wsPath;

  router.use(express.json({ limit: '4mb' }));
  router.use(express.static(path.join(options.appRoot, 'public'), { index: false }));

  router.get('/', (_req, res) => {
    res.type('html').send(renderIndexHtml(options.appRoot, basePath));
  });

  router.get('/api/context', asyncRoute(async (_req, res) => {
    const workflows = await store.list();
    const claude = await getClaudeStatus(options.projectRoot, options.appRoot);
    res.json({
      projectRoot: options.projectRoot,
      projectKey: options.projectKey || '',
      basePath,
      wsPath,
      workflowsPath: path.join(options.projectRoot, '.claude', 'workflows'),
      claude,
      workflowCount: workflows.length
    });
  }));

  router.get('/api/workflows', asyncRoute(async (_req, res) => {
    res.json({ workflows: await store.list({ reload: true }) });
  }));

  router.post('/api/workflows', asyncRoute(async (req, res) => {
    const workflow = await store.create(req.body || {});
    req.app.locals.ws?.broadcast('workflow.saved', workflow);
    res.status(201).json({ workflow });
  }));

  router.put('/api/workflows/:id', asyncRoute(async (req, res) => {
    const workflow = await store.save({ ...req.body, id: req.params.id });
    req.app.locals.ws?.broadcast('workflow.saved', workflow);
    res.json({ workflow });
  }));

  router.delete('/api/workflows/:id', asyncRoute(async (req, res) => {
    const ok = await store.delete(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    req.app.locals.ws?.broadcast('workflow.deleted', { id: req.params.id });
    res.json({ ok: true });
  }));

  router.post('/api/workflows/:id/run', asyncRoute(async (req, res) => {
    const workflow = await store.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const run = await engine.execute(workflow, req.body?.input || '');
    res.status(202).json({ run });
  }));

  router.post('/api/runs/:id/cancel', asyncRoute(async (req, res) => {
    const ok = engine.cancel(req.params.id);
    res.json({ ok });
  }));

  router.get('/api/runs', asyncRoute(async (_req, res) => {
    res.json({ runs: await engine.readRuns() });
  }));

  if (basePath !== '/') {
    app.get('/', (_req, res) => res.redirect(302, basePath));
    app.use((req, res, next) => {
      if (req.path === mountPath && !req.originalUrl.endsWith('/')) {
        res.redirect(302, basePath);
        return;
      }
      next();
    });
  }
  app.use(mountPath, router);

  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({
      error: error.message || 'Internal server error'
    });
  });

  return { app, store, engine };
}

async function startDashboard(options) {
  const host = options.host || '127.0.0.1';
  const port = await findOpenPort(host, options.port || 4747);
  const basePath = normalizeBasePath(options.basePath || '/');
  const wsPath = wsPathForBasePath(basePath);
  const { app, store, engine } = createApp({ ...options, basePath });
  await store.load();

  const server = http.createServer(app);
  const ws = new WsHub(server, { path: wsPath });
  app.locals.ws = ws;

  const forwardEvents = [
    'workflow.runStarted',
    'workflow.nodeStarted',
    'workflow.output',
    'workflow.nodeCompleted',
    'workflow.nodeFailed',
    'workflow.runCompleted',
    'workflow.runFailed'
  ];
  for (const eventName of forwardEvents) {
    engine.on(eventName, (payload) => ws.broadcast(eventName, payload));
  }

  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    app,
    host,
    port,
    basePath,
    wsPath,
    projectKey: options.projectKey || '',
    server,
    ws,
    close: async () => {
      await ws.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = {
  createApp,
  startDashboard
};
