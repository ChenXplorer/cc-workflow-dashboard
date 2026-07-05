const assert = require('assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const test = require('node:test');
const {
  extractDashboardGraph,
  generateWorkflowScript,
  normalizeWorkflowGraph,
  parseWorkflowScript,
  readOfficialWorkflows,
  writeOfficialWorkflow
} = require('../src/lib/official-workflows');

async function tmpProject() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'official-workflows-'));
}

test('parseWorkflowScript extracts phases and agent calls from official JS workflow', () => {
  const workflow = parseWorkflowScript(`
/** 示例 workflow */
phase("规划");
const plan = await agent(\`分析 \${args}\`, { label: "规划智能体", model: "sonnet" });
`, 'example');

  assert.equal(workflow.commandName, 'example');
  assert.equal(workflow.nodes.some((node) => node.type === 'phase' && node.label === '规划'), true);
  assert.equal(workflow.nodes.some((node) => node.type === 'step' && node.label === '规划智能体'), true);
});

test('parseWorkflowScript reads official meta without dashboard metadata', () => {
  const workflow = parseWorkflowScript(`export const meta = {
  "name": "official-only",
  "description": "官方脚本",
  "phases": [{ "title": "扫描", "detail": "读取项目" }]
};

phase("扫描");
await agent(\`读取项目：\${args.task}\`, { label: "扫描智能体" });
`, 'official-only');

  assert.equal(workflow.name, 'official-only');
  assert.equal(workflow.description, '官方脚本');
  assert.equal(workflow.nodes.some((node) => node.type === 'phase' && node.label === '扫描'), true);
});

test('generateWorkflowScript creates a Claude Code dynamic workflow script', () => {
  const script = generateWorkflowScript({
    name: '实现并验证',
    description: '测试脚本',
    nodes: [
      { id: 'a', type: 'step', label: '规划', model: 'sonnet', prompt: '处理：{task}\n{previous}' }
    ]
  });

  assert.match(script, /phase|agent/);
  assert.match(script, /^export const meta = /);
  assert.equal(Boolean(extractDashboardGraph(script)), true);
  assert.match(script, /const task/);
  assert.match(script, /return previous/);
});

test('generateWorkflowScript keeps dashboard graph after official meta block', () => {
  const script = generateWorkflowScript({
    id: 'official-first',
    commandName: 'official-first',
    name: '官方优先',
    description: '验证 meta 在首行',
    nodes: [
      { id: 'start', type: 'start', label: '开始' },
      { id: 'a', type: 'step', label: '执行', prompt: '任务：{task}' },
      { id: 'end', type: 'end', label: '结束' }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'end' }
    ]
  });

  assert.match(script, /^export const meta = /);
  assert.equal(script.indexOf('export const meta'), 0);
  assert.equal(script.indexOf('ultracode-dashboard:graph') > script.indexOf('export const meta'), true);
  assert.match(script, /label: "执行"/);
});

test('parseWorkflowScript restores UI placeholders from dashboard metadata', () => {
  const workflow = parseWorkflowScript(`export const meta = { "name": "x", "description": "x", "phases": [] };

/* ultracode-dashboard:graph
{"version":1,"nodes":[{"id":"a","type":"step","prompt":"任务：\${task}\\n上游：\${previous}"}],"edges":[]}
*/
`, 'placeholder');

  assert.equal(workflow.nodes[0].prompt, '任务：{task}\n上游：{previous}');
});

test('generateWorkflowScript follows visual edge topology', () => {
  const script = generateWorkflowScript({
    name: '拓扑顺序',
    nodes: [
      { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
      { id: 'a', type: 'step', label: '后执行', prompt: 'A {previous}', position: { x: 600, y: 0 } },
      { id: 'b', type: 'step', label: '先执行', prompt: 'B {task}', position: { x: 300, y: 0 } },
      { id: 'end', type: 'end', label: '结束', position: { x: 900, y: 0 } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
      { id: 'e3', source: 'a', target: 'end' }
    ]
  });

  assert.equal(script.indexOf('label: "先执行"') < script.indexOf('label: "后执行"'), true);
});

test('generateWorkflowScript maps visual fan-out edges to static parallel branches', () => {
  const script = generateWorkflowScript({
    name: '静态并行分支',
    nodes: [
      { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
      { id: 'plan', type: 'step', label: '任务规划师', prompt: '规划 {task}', position: { x: 280, y: 100 } },
      { id: 'front', type: 'step', label: '前端开发者', prompt: '前端 {previous}', position: { x: 560, y: 20 } },
      { id: 'back', type: 'step', label: '后端开发者', prompt: '后端 {previous}', position: { x: 560, y: 180 } },
      { id: 'review', type: 'step', label: '审核员', prompt: '审核 {previous}', position: { x: 840, y: 100 } },
      { id: 'end', type: 'end', label: '结束', position: { x: 1120, y: 100 } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'plan' },
      { id: 'e2', source: 'plan', target: 'front' },
      { id: 'e3', source: 'plan', target: 'back' },
      { id: 'e4', source: 'front', target: 'review' },
      { id: 'e5', source: 'back', target: 'review' },
      { id: 'e6', source: 'review', target: 'end' }
    ]
  });

  assert.match(script, /const \[result_front, result_back\] = await parallel/);
  assert.equal(script.indexOf('label: "前端开发者"') < script.indexOf('label: "审核员"'), true);
  assert.match(script, /\[results\["front"\], results\["back"\]\]\.filter\(Boolean\)\.join/);
});

test('generateWorkflowScript lets agents inherit phase from connected phase markers', () => {
  const script = generateWorkflowScript({
    name: '阶段继承',
    nodes: [
      { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
      { id: 'phase_plan', type: 'phase', label: '规划', prompt: '先规划。', position: { x: 280, y: 0 } },
      { id: 'agent_plan', type: 'step', label: '规划智能体', prompt: '规划 {task}', position: { x: 560, y: 0 } },
      { id: 'end', type: 'end', label: '结束', position: { x: 840, y: 0 } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'phase_plan' },
      { id: 'e2', source: 'phase_plan', target: 'agent_plan' },
      { id: 'e3', source: 'agent_plan', target: 'end' }
    ]
  });

  assert.match(script, /phase\("规划"\);/);
  assert.match(script, /label: "规划智能体", phase: "规划"/);
});

test('generateWorkflowScript maps parallel group nodes to Claude Code parallel agents', () => {
  const script = generateWorkflowScript({
    id: 'parallel-demo',
    commandName: 'parallel-demo',
    name: 'Parallel demo',
    nodes: [
      { id: 'start', type: 'start', label: 'Start' },
      {
        id: 'fanout',
        type: 'parallel',
        label: 'Review files',
        phase: 'Review',
        model: 'sonnet',
        parallelSource: 'args.files',
        itemName: 'file',
        maxConcurrency: 99,
        prompt: 'Review {item} for task {task}. Previous: {previous}'
      },
      { id: 'end', type: 'end', label: 'End' }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'fanout' },
      { id: 'e2', source: 'fanout', target: 'end' }
    ]
  });

  assert.match(script, /await parallel/);
  assert.match(script, /args\?\.files/);
  assert.match(script, /formatParallelItem\(file\)/);
  assert.match(script, /offset \+= 16/);
  assert.match(script, /model: "sonnet"/);
  assert.equal(extractDashboardGraph(script).nodes.find((node) => node.id === 'fanout').type, 'parallel');
  assert.equal(extractDashboardGraph(script).nodes.find((node) => node.id === 'fanout').maxConcurrency, 16);
});

test('generateWorkflowScript does not create a hidden agent for empty visual flows', () => {
  const script = generateWorkflowScript({
    name: 'Empty visual flow',
    nodes: [
      { id: 'start', type: 'start', label: 'Start' },
      { id: 'end', type: 'end', label: 'End' }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'end' }
    ]
  });

  assert.doesNotMatch(script, /await agent/);
  assert.match(script, /previous = task/);
});

test('parseWorkflowScript represents official parallel scripts as a parallel group when dashboard metadata is absent', () => {
  const workflow = parseWorkflowScript(`export const meta = {
  name: "parallel-only",
  description: "Parallel script",
  phases: [{ title: "Review", detail: "Review in parallel" }]
};

phase("Review");
const results = await parallel([
  () => agent("A", { label: "A" }),
  () => agent("B", { label: "B" })
]);
return results.join("\\n");
`, 'parallel-only');

  assert.equal(workflow.nodes.some((node) => node.type === 'parallel'), true);
  assert.equal(workflow.nodes.some((node) => node.type === 'step'), false);
});

test('normalizeWorkflowGraph removes invalid duplicate and self edges', () => {
  const workflow = normalizeWorkflowGraph({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'step' },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'start', target: 'a' },
      { id: 'e3', source: 'a', target: 'a' },
      { id: 'e4', source: 'missing', target: 'end' },
      { id: 'e5', source: 'a', target: 'end' }
    ]
  });

  assert.deepEqual(workflow.edges.map((edge) => [edge.source, edge.target]), [
    ['start', 'a'],
    ['a', 'end']
  ]);
});

test('writeOfficialWorkflow cleans invalid graph edges before writing metadata', async () => {
  const root = await tmpProject();
  const saved = await writeOfficialWorkflow(root, {
    commandName: 'clean-edges',
    name: 'Clean edges',
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'step', label: 'A', prompt: 'A' },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'start', target: 'a' },
      { id: 'e3', source: 'a', target: 'missing' },
      { id: 'e4', source: 'a', target: 'end' }
    ]
  });

  const raw = await fsp.readFile(saved.file, 'utf8');
  assert.deepEqual(extractDashboardGraph(raw).edges.map((edge) => [edge.source, edge.target]), [
    ['start', 'a'],
    ['a', 'end']
  ]);
});

test('writeOfficialWorkflow writes only .claude/workflows script files', async () => {
  const root = await tmpProject();
  const saved = await writeOfficialWorkflow(root, {
    commandName: 'my-workflow',
    name: '我的工作流',
    description: '说明',
    nodes: [
      { id: 'a', type: 'step', label: '执行', prompt: '执行：{task}' }
    ]
  });

  assert.equal(saved.commandName, 'my-workflow');
  assert.match(saved.file, /[\\/]\.claude[\\/]workflows[\\/]my-workflow\.js$/);

  const workflows = await readOfficialWorkflows(root);
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].commandName, 'my-workflow');
  assert.deepEqual(workflows[0].edges.map((edge) => [edge.source, edge.target]), saved.edges.map((edge) => [edge.source, edge.target]));
});

test('writeOfficialWorkflow preserves dashboard graph metadata in official script', async () => {
  const root = await tmpProject();
  const saved = await writeOfficialWorkflow(root, {
    commandName: 'graph-workflow',
    name: 'Graph workflow',
    description: 'Graph metadata',
    nodes: [
      { id: 'start', type: 'start', label: '开始', position: { x: 1, y: 2 } },
      { id: 'a', type: 'step', label: 'A', prompt: 'A {task}', position: { x: 3, y: 4 } },
      { id: 'b', type: 'step', label: 'B', prompt: 'B {previous}', position: { x: 5, y: 6 } },
      { id: 'end', type: 'end', label: '结束', position: { x: 7, y: 8 } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'end' }
    ]
  });

  const raw = await fsp.readFile(saved.file, 'utf8');
  assert.equal(extractDashboardGraph(raw).nodes.length, 4);

  const [loaded] = await readOfficialWorkflows(root);
  assert.equal(loaded.nodes.find((node) => node.id === 'a').position.x, 3);
  assert.equal(loaded.edges.length, 3);
});

test('raw script edits are saved without stale dashboard metadata', async () => {
  const root = await tmpProject();
  const saved = await writeOfficialWorkflow(root, {
    commandName: 'raw-workflow',
    name: 'Raw',
    rawScriptEdited: true,
    script: `
/* ultracode-dashboard:graph
{"version":1,"nodes":[{"id":"old","type":"step"}],"edges":[]}
*/
phase("新阶段");
await agent(\`新脚本\`, { label: "新智能体" });
`
  });

  const raw = await fsp.readFile(saved.file, 'utf8');
  assert.equal(extractDashboardGraph(raw), null);
  assert.match(raw, /^export const meta = /);
  const loaded = parseWorkflowScript(raw, 'raw-workflow');
  assert.equal(loaded.nodes.some((node) => node.label === '新智能体'), true);
});
