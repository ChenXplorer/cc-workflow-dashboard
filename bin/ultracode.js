#!/usr/bin/env node

const path = require('path');
const { startDashboard } = require('../src/server');
const { openBrowser } = require('../src/lib/open-browser');
const {
  normalizeBasePath,
  projectDashboardDefaults
} = require('../src/lib/project-instance');

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: null,
    open: true,
    cwd: process.cwd(),
    basePath: ''
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-open') args.open = false;
    else if (arg === '--host') args.host = argv[++i] || args.host;
    else if (arg.startsWith('--host=')) args.host = arg.slice('--host='.length);
    else if (arg === '--port') args.port = Number(argv[++i]) || args.port;
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length)) || args.port;
    else if (arg === '--cwd') args.cwd = argv[++i] || args.cwd;
    else if (arg.startsWith('--cwd=')) args.cwd = arg.slice('--cwd='.length);
    else if (arg === '--base-path' || arg === '--route') args.basePath = argv[++i] || args.basePath;
    else if (arg.startsWith('--base-path=')) args.basePath = arg.slice('--base-path='.length);
    else if (arg.startsWith('--route=')) args.basePath = arg.slice('--route='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: ultracode [--cwd <project>] [--port <port>] [--base-path <path>] [--host 127.0.0.1] [--no-open]

Starts a dashboard for the target project. By default the port and route are
derived from the project path, so multiple projects can run at the same time.

Options:
  --cwd <project>       Project root to read/write .claude/workflows
  --port <port>         Preferred port; if busy, the next open port is used
  --base-path <path>    URL route prefix, for example /ultracode/my-app/
  --route <path>        Alias for --base-path
  --host <host>         Host to bind, default 127.0.0.1
  --no-open            Do not open a browser automatically`);
      process.exit(0);
    }
  }

  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  const projectRoot = path.resolve(args.cwd);
  const appRoot = path.resolve(__dirname, '..');
  const defaults = projectDashboardDefaults(projectRoot);
  const basePath = normalizeBasePath(args.basePath || defaults.basePath);
  const port = args.port || defaults.port;

  const dashboard = await startDashboard({
    projectRoot,
    appRoot,
    projectKey: defaults.projectKey,
    host: args.host,
    port,
    basePath
  });

  const url = `http://${dashboard.host}:${dashboard.port}${dashboard.basePath}`;
  console.log(`Ultracode dashboard: ${url}`);
  console.log(`Project: ${projectRoot}`);
  console.log(`Project key: ${defaults.projectKey}`);
  console.log(`Route: ${dashboard.basePath}`);

  if (args.open) {
    openBrowser(url);
  }

  const shutdown = async () => {
    await dashboard.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
