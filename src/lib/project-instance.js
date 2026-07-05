const path = require('path');
const { shortHash, slugify } = require('./ids');

const DEFAULT_PORT_BASE = 4700;
const DEFAULT_PORT_SPAN = 1000;

function normalizedProjectRoot(projectRoot) {
  return path.resolve(projectRoot || process.cwd());
}

function projectInstanceKey(projectRoot) {
  const root = normalizedProjectRoot(projectRoot);
  const hashInput = process.platform === 'win32' ? root.toLowerCase() : root;
  const hash = shortHash(hashInput);
  const name = slugify(path.basename(root), 'project');
  return `${name}-${hash}`;
}

function defaultPortForProject(projectRoot) {
  const key = projectInstanceKey(projectRoot);
  const hash = key.slice(-8);
  const offset = Number.parseInt(hash.slice(0, 6), 16) % DEFAULT_PORT_SPAN;
  return DEFAULT_PORT_BASE + offset;
}

function normalizeBasePath(basePath) {
  let value = String(basePath || '').trim();
  if (!value || value === '/') return '/';
  value = value.replace(/\\/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/+/g, '/');
  if (!value.endsWith('/')) value = `${value}/`;
  return value;
}

function mountPathForBasePath(basePath) {
  const normalized = normalizeBasePath(basePath);
  return normalized === '/' ? '/' : normalized.slice(0, -1);
}

function wsPathForBasePath(basePath) {
  const mountPath = mountPathForBasePath(basePath);
  return mountPath === '/' ? '/ws' : `${mountPath}/ws`;
}

function projectDashboardDefaults(projectRoot) {
  const root = normalizedProjectRoot(projectRoot);
  const projectKey = projectInstanceKey(root);
  return {
    projectRoot: root,
    projectKey,
    port: defaultPortForProject(root),
    basePath: `/ultracode/${projectKey}/`
  };
}

module.exports = {
  DEFAULT_PORT_BASE,
  DEFAULT_PORT_SPAN,
  defaultPortForProject,
  mountPathForBasePath,
  normalizeBasePath,
  projectDashboardDefaults,
  projectInstanceKey,
  wsPathForBasePath
};
