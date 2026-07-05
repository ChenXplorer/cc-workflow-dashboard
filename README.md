# Ultracode

[![npm version](https://img.shields.io/npm/v/cc-workflow-dashboard.svg)](https://www.npmjs.com/package/cc-workflow-dashboard)
[![license](https://img.shields.io/npm/l/cc-workflow-dashboard.svg)](./LICENSE)

Ultracode is a visual dashboard for creating, editing, running, and organizing
Claude Code project workflows.

It reads and writes the official Claude Code workflow directory in the current
project:

```text
.claude/workflows/
```

No separate database is created. Your workflow JavaScript files remain the
source of truth.

## Features

- Visual node canvas for Claude Code workflows
- Create, edit, delete, and run project workflows
- Saves back to official `.claude/workflows/*.js` scripts
- Supports `args`, `phase()`, `agent()`, `parallel()`, and `return` workflow patterns
- Restores visual node positions from metadata stored inside the workflow script
- Runs saved workflows through Claude Code CLI
- Project-isolated ports and URL routes, so multiple projects can run dashboards at the same time
- Optional DeepSeek Anthropic-compatible endpoint mapping for Claude Code

## Install

Run once with `npx`:

```bash
npx cc-workflow-dashboard
```

Or install globally:

```bash
npm install -g cc-workflow-dashboard
```

Then start it from any project:

```bash
cd /path/to/your-project
ultracode
```

You can also install it as a project dev dependency:

```bash
npm install --save-dev cc-workflow-dashboard
npx ultracode
```

## Usage

Start Ultracode from the project whose workflows you want to manage:

```bash
cd /path/to/project-a
ultracode
```

The dashboard will open a local URL similar to:

```text
http://127.0.0.1:5234/ultracode/project-a-a1b2c3d4/
```

The target project is the current working directory by default. To manage a
different project without changing directories, pass `--cwd`:

```bash
ultracode --cwd /path/to/project-b
```

Each project gets a stable default port and route derived from its absolute
path. If the preferred port is busy, Ultracode automatically uses the next open
port. You can override the preferred port or route:

```bash
ultracode --port 4888 --base-path /ultracode/custom-project/
```

CLI options:

```text
Usage: ultracode [--cwd <project>] [--port <port>] [--base-path <path>] [--host 127.0.0.1] [--no-open]

Options:
  --cwd <project>       Project root to read/write .claude/workflows
  --port <port>         Preferred port; if busy, the next open port is used
  --base-path <path>    URL route prefix, for example /ultracode/my-app/
  --route <path>        Alias for --base-path
  --host <host>         Host to bind, default 127.0.0.1
  --no-open             Do not open a browser automatically
```

## Workflow Model

Claude Code dynamic workflows are JavaScript scripts. A saved workflow lives at:

```text
.claude/workflows/<workflow-name>.js
```

and becomes available in Claude Code as:

```text
/<workflow-name>
```

Ultracode generates official workflow code such as:

```js
export const meta = {
  name: "implement-and-verify",
  description: "Plan, implement, and verify a task with Claude Code.",
  phases: [{ title: "Plan" }, { title: "Implement" }, { title: "Verify" }]
};

const task = typeof args === "string" ? args : (args?.task ?? JSON.stringify(args ?? ""));

phase("Plan");
const plan = await agent(`Plan this task:\n${task}`, { label: "Planner" });

phase("Implement");
const result = await agent(`Implement this plan:\n${plan}`, { label: "Developer" });

return result;
```

The dashboard stores visual graph metadata in a comment after `meta`. Claude
Code ignores that comment, while Ultracode uses it to restore the canvas.

## Running Workflows

When you click Run, Ultracode starts Claude Code in non-interactive print mode
and sends a saved slash command like:

```text
/<workflow-name> {"task":"Describe the work here"}
```

The generated workflow reads that value through `args.task`.

For non-interactive runs, Ultracode uses:

```text
--permission-mode bypassPermissions
```

by default so the workflow can run without interactive approval prompts. You can
override this with:

```bash
ULTRACODE_PERMISSION_MODE=default ultracode
```

PowerShell:

```powershell
$env:ULTRACODE_PERMISSION_MODE = "default"
ultracode
```

## DeepSeek Endpoint

If `DEEPSEEK_API_KEY` is present, Ultracode maps it to Claude Code's
Anthropic-compatible environment variables at process launch:

```text
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<DEEPSEEK_API_KEY>
ANTHROPIC_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
```

Example:

```powershell
$env:DEEPSEEK_API_KEY = "<your DeepSeek API key>"
ultracode
```

Secrets are kept in environment variables and are not written into workflow
files.

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/ChenXplorer/cc-workflow-dashboard.git
cd cc-workflow-dashboard
npm install
```

Run locally:

```bash
npm start
```

Build the web UI:

```bash
npm run build:web
```

Run tests:

```bash
npm test
```

Check the npm package contents:

```bash
npm run pack:check
```

Install this checkout globally for local testing:

```bash
npm install -g .
```

## Privacy

Ultracode is a local dashboard. It serves a local web app and reads/writes only
the project root you start it for, unless you pass `--cwd` to point at another
project.

Project workflow files are stored in `.claude/workflows/`. Local `.claude/`
runtime state is intentionally ignored by this repository.

## License

MIT. See [LICENSE](./LICENSE).
