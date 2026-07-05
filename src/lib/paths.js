const os = require('os');
const path = require('path');

function claudeDir(projectRoot) {
  return path.join(projectRoot, '.claude');
}

function userClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

module.exports = {
  claudeDir,
  userClaudeDir,
};
