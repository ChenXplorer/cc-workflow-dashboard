const path = require('path');
const fsp = require('fs/promises');
const { ensureDir, listFilesRecursive, removeIfExists, writeFileAtomic } = require('./file-utils');
const { claudeDir } = require('./paths');
const { createId, slugify } = require('./ids');

const WORKFLOW_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const GRAPH_BLOCK_RE = /\/\*\s*ultracode-dashboard:graph\s*\n([\s\S]*?)\n\s*\*\//m;
const META_BLOCK_RE = /export\s+const\s+meta\s*=\s*({[\s\S]*?})\s*;[ \t]*(?:\r?\n)?/m;
const EXECUTABLE_NODE_TYPES = new Set(['step', 'parallel']);
const ALLOWED_NODE_TYPES = new Set(['start', 'step', 'parallel', 'phase', 'end']);

function projectWorkflowsDir(projectRoot) {
  return path.join(claudeDir(projectRoot), 'workflows');
}

function isWorkflowScript(file) {
  return WORKFLOW_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function workflowCommandName(file) {
  return path.basename(file, path.extname(file));
}

function workflowScriptPath(projectRoot, commandName) {
  return path.join(projectWorkflowsDir(projectRoot), `${slugify(commandName, 'workflow')}.js`);
}

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function jsComment(value) {
  return String(value || '').replace(/\r?\n/g, ' ').replace(/\*\//g, '* /');
}

function jsIdentifier(value, fallback = 'workflow') {
  return slugify(value, fallback).replace(/-/g, '_');
}

function nodeVariable(node) {
  return jsIdentifier(node.id || node.label, 'node');
}

function promptTemplate(value) {
  return String(value || '')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\{task\}/g, '${task}')
    .replace(/\{previous\}/g, '${previous}');
}

function parallelPromptTemplate(value, itemExpression) {
  return promptTemplate(value)
    .replace(/\{item\}/g, `\${formatParallelItem(${itemExpression})}`);
}

function jsTemplate(value) {
  return String(value || '')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function stripDashboardGraph(script) {
  return String(script || '').replace(GRAPH_BLOCK_RE, '').trimStart();
}

function stripWorkflowMeta(script) {
  return String(script || '').replace(META_BLOCK_RE, '').trimStart();
}

function extractDashboardGraph(script) {
  const match = String(script || '').match(GRAPH_BLOCK_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractWorkflowMeta(script) {
  const source = String(script || '');
  const match = source.match(META_BLOCK_RE);
  if (!match) return {};
  const raw = match[1];
  const field = (key) => raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`));
  const name = field('name');
  const description = field('description');
  const phases = [];
  const phasesBlock = raw.match(/["']?phases["']?\s*:\s*\[([\s\S]*?)\]/);
  if (phasesBlock) {
    const phasePattern = /{\s*["']?title["']?\s*:\s*(['"`])([\s\S]*?)\1(?:\s*,\s*["']?detail["']?\s*:\s*(['"`])([\s\S]*?)\3)?[\s,]*}/g;
    for (const phaseMatch of phasesBlock[1].matchAll(phasePattern)) {
      phases.push({
        title: phaseMatch[2],
        detail: phaseMatch[4] || ''
      });
    }
  }
  return {
    name: name?.[2] || '',
    description: description?.[2] || '',
    phases
  };
}

function phaseTitle(node) {
  return node.phase || '';
}

function workflowPhases(workflow) {
  const normalized = normalizeWorkflowGraph(workflow);
  const phases = [];
  const seen = new Set();
  for (const node of topoOrder(normalized)) {
    if (node.type !== 'phase' && node.type !== 'step' && node.type !== 'parallel') continue;
    const title = node.type === 'phase' ? node.label || '阶段' : phaseTitle(node);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    phases.push({
      title,
      detail: node.type === 'phase'
        ? (node.prompt || '')
        : node.type === 'parallel'
          ? `${node.label || '列表并行'} 用同一模板批量启动多个 agent`
          : `${node.label || '智能体'} agent()`
    });
  }
  if (!phases.length) phases.push({ title: '执行', detail: '执行工作流任务' });
  return phases;
}

function workflowMeta(workflow) {
  const commandName = slugify(workflow.commandName || workflow.id || workflow.name, 'workflow');
  return {
    name: commandName,
    description: workflow.description || workflow.name || commandName,
    phases: workflowPhases({ ...workflow, commandName })
  };
}

function metaBlock(workflow) {
  return `export const meta = ${JSON.stringify(workflowMeta(workflow), null, 2)};\n\n`;
}

function dashboardGraph(workflow) {
  const normalized = normalizeWorkflowGraph(workflow);
  return {
    version: 1,
    name: normalized.name || normalized.commandName || normalized.id,
    commandName: normalized.commandName || normalized.id,
    description: normalized.description || '',
    nodes: (normalized.nodes || []).map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label || '',
      position: node.position || { x: 0, y: 0 },
      prompt: node.prompt || '',
      model: node.model || 'inherit',
      agentRole: node.agentRole || 'general',
      phase: node.phase || '',
      parallelSource: node.parallelSource || 'args.items',
      parallelItems: node.parallelItems || '',
      itemName: node.itemName || 'item',
      maxConcurrency: node.maxConcurrency || 16
    })),
    edges: (normalized.edges || []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label || ''
    }))
  };
}

function graphBlock(workflow) {
  return `/* ultracode-dashboard:graph\n${JSON.stringify(dashboardGraph(workflow), null, 2)}\n*/\n\n`;
}

function extractDescription(script) {
  const meta = extractWorkflowMeta(script);
  if (meta.description) return meta.description;
  const comment = stripWorkflowMeta(stripDashboardGraph(script)).match(/\/\*\*([\s\S]*?)\*\//);
  if (!comment) return '';
  return comment[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);
}

function parseOptionsObject(raw) {
  if (!raw) return {};
  const out = {};
  const label = raw.match(/\blabel\s*:\s*(['"`])([\s\S]*?)\1/);
  const model = raw.match(/\bmodel\s*:\s*(['"`])([\s\S]*?)\1/);
  const agent = raw.match(/\bagent\s*:\s*(['"`])([\s\S]*?)\1/);
  const phase = raw.match(/\bphase\s*:\s*(['"`])([\s\S]*?)\1/);
  if (label) out.label = label[2];
  if (model) out.model = model[2];
  if (agent) out.agent = agent[2];
  if (phase) out.phase = phase[2];
  return out;
}

function normalizeNode(node, index) {
  const prompt = String(node.prompt || '')
    .replace(/\\?\$\{task\}/g, '{task}')
    .replace(/\\?\$\{previous\}/g, '{previous}')
    .replace(/\\?\$\{item\}/g, '{item}');
  const maxConcurrency = Number.parseInt(node.maxConcurrency, 10);
  const type = ALLOWED_NODE_TYPES.has(node.type) ? node.type : 'step';
  return {
    id: node.id || createId('node'),
    type,
    label: node.label || type || `节点 ${index + 1}`,
    position: node.position || { x: 120 + index * 240, y: 180 },
    prompt,
    model: node.model || 'inherit',
    agentRole: node.agentRole || 'general',
    phase: node.phase || '',
    parallelSource: node.parallelSource || 'args.items',
    parallelItems: node.parallelItems || '',
    itemName: jsIdentifier(node.itemName || 'item', 'item'),
    maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, Math.min(16, maxConcurrency)) : 16
  };
}

function normalizeEdge(edge, index) {
  return {
    id: edge.id || `edge_${index}`,
    source: edge.source,
    target: edge.target,
    label: edge.label || ''
  };
}

function normalizeWorkflowGraph(workflow = {}) {
  const nodes = (workflow.nodes || []).map(normalizeNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seenEdges = new Set();
  const edges = [];

  for (const rawEdge of workflow.edges || []) {
    const edge = normalizeEdge(rawEdge, edges.length);
    const key = `${edge.source}->${edge.target}`;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }

  return {
    ...workflow,
    nodes,
    edges
  };
}

function parseWorkflowScript(script, commandName) {
  const source = String(script || '');
  const meta = extractWorkflowMeta(source);
  const graph = extractDashboardGraph(source);
  if (graph) {
    const normalized = normalizeWorkflowGraph({
      nodes: graph.nodes,
      edges: graph.edges
    });
    return {
      id: commandName,
      commandName,
      name: graph.name || meta.name || commandName,
      description: graph.description || meta.description || extractDescription(source),
      script: source,
      nodes: normalized.nodes,
      edges: normalized.edges
    };
  }

  const executableSource = stripWorkflowMeta(stripDashboardGraph(source));
  const nodes = [{
    id: 'start',
    type: 'start',
    label: '任务输入',
    position: { x: 80, y: 210 }
  }];
  const edges = [];

  const phasePattern = /phase\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/g;
  let phaseIndex = 0;
  for (const match of executableSource.matchAll(phasePattern)) {
    phaseIndex += 1;
    nodes.push({
      id: `phase_${phaseIndex}`,
      type: 'phase',
      label: match[2].trim() || `阶段 ${phaseIndex}`,
      prompt: '',
      position: { x: 120 + phaseIndex * 230, y: 80 }
    });
  }

  const hasParallel = /\bparallel\s*\(/.test(executableSource);
  if (hasParallel) {
    nodes.push({
      id: 'parallel_1',
      type: 'parallel',
      label: '列表并行',
      prompt: '从官方脚本中检测到 parallel()。如果需要保留完整逻辑，请在源码面板编辑。',
      parallelSource: 'previous-json',
      position: { x: 330, y: 190 }
    });
  } else {
    const agentPattern = /agent\s*\(\s*(['"`])([\s\S]*?)\1\s*(?:,\s*({[\s\S]*?})\s*)?\)/g;
    let agentIndex = 0;
    for (const match of executableSource.matchAll(agentPattern)) {
      agentIndex += 1;
      const options = parseOptionsObject(match[3]);
      nodes.push({
        id: `agent_${agentIndex}`,
        type: 'step',
        label: options.label || options.agent || `智能体 ${agentIndex}`,
        prompt: match[2].trim(),
        model: options.model || 'inherit',
        agentRole: 'general',
        phase: options.phase || '',
        position: { x: 310 + (agentIndex - 1) * 250, y: 190 }
      });
    }
  }

  if (nodes.length === 1) {
    nodes.push({
      id: 'source_step',
      type: 'step',
      label: '源码智能体',
      prompt: executableSource.slice(0, 1000),
      position: { x: 330, y: 190 }
    });
  }

  nodes.push({
    id: 'end',
    type: 'end',
    label: '完成',
    position: { x: Math.min(1150, 330 + Math.max(1, nodes.length - 2) * 250), y: 210 }
  });

  const executable = nodes.filter((node) => node.id !== 'start' && node.id !== 'end' && node.type !== 'phase');
  const sequence = ['start', ...executable.map((node) => node.id), 'end'];
  for (let i = 0; i < sequence.length - 1; i += 1) {
    edges.push({ id: `edge_${i}`, source: sequence[i], target: sequence[i + 1] });
  }

  return {
    id: commandName,
    commandName,
    name: meta.name || commandName,
    description: meta.description || extractDescription(executableSource),
    script: source,
    nodes,
    edges
  };
}

function topoOrder(workflow) {
  const normalizedWorkflow = normalizeWorkflowGraph(workflow);
  const nodes = normalizedWorkflow.nodes || [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));

  for (const edge of normalizedWorkflow.edges || []) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source).push(edge.target);
  }

  const queue = nodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .sort((a, b) => {
      if (a.type === 'start' && b.type !== 'start') return -1;
      if (a.type !== 'start' && b.type === 'start') return 1;
      return (a.position?.x || 0) - (b.position?.x || 0);
    })
    .map((node) => node.id);
  const seen = new Set();
  const ordered = [];

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(nodeMap.get(id));
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if ((indegree.get(next) || 0) <= 0) queue.push(next);
    }
  }

  for (const node of nodes) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}

function workflowMaps(workflow) {
  const normalizedWorkflow = normalizeWorkflowGraph(workflow);
  const nodes = normalizedWorkflow.nodes || [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of normalizedWorkflow.edges || []) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    incoming.get(edge.target).push(edge.source);
    outgoing.get(edge.source).push(edge.target);
  }
  return { nodes, nodeMap, incoming, outgoing };
}

function upstreamExecutableIds(nodeId, incoming, nodeMap, seen = new Set()) {
  if (seen.has(nodeId)) return [];
  seen.add(nodeId);
  const ids = [];
  for (const prevId of incoming.get(nodeId) || []) {
    const prev = nodeMap.get(prevId);
    if (!prev) continue;
    if (EXECUTABLE_NODE_TYPES.has(prev.type)) {
      ids.push(prev.id);
      continue;
    }
    ids.push(...upstreamExecutableIds(prev.id, incoming, nodeMap, seen));
  }
  return [...new Set(ids)];
}

function nearestPhaseBefore(nodeId, incoming, nodeMap, seen = new Set()) {
  if (seen.has(nodeId)) return '';
  seen.add(nodeId);
  for (const prevId of incoming.get(nodeId) || []) {
    const prev = nodeMap.get(prevId);
    if (!prev) continue;
    if (prev.type === 'phase' && prev.label) return prev.label;
    if (!EXECUTABLE_NODE_TYPES.has(prev.type)) {
      const nested = nearestPhaseBefore(prev.id, incoming, nodeMap, seen);
      if (nested) return nested;
    }
  }
  return '';
}

function executableGraph(workflow) {
  const { nodes, nodeMap, incoming } = workflowMaps(workflow);
  const executable = nodes.filter((node) => EXECUTABLE_NODE_TYPES.has(node.type));
  const dependencies = new Map();
  const dependents = new Map(executable.map((node) => [node.id, []]));

  for (const node of executable) {
    const deps = upstreamExecutableIds(node.id, incoming, nodeMap);
    dependencies.set(node.id, deps);
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(node.id);
    }
  }

  return { executable, dependencies, dependents, nodeMap, incoming };
}

function executionLevels(workflow) {
  const graph = executableGraph(workflow);
  const indegree = new Map(graph.executable.map((node) => [node.id, (graph.dependencies.get(node.id) || []).length]));
  let queue = graph.executable
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .sort((a, b) => (a.position?.x || 0) - (b.position?.x || 0) || (a.position?.y || 0) - (b.position?.y || 0));
  const levels = [];
  const seen = new Set();

  while (queue.length) {
    const level = queue.filter((node) => !seen.has(node.id));
    if (!level.length) break;
    levels.push(level);
    const next = [];
    for (const node of level) {
      seen.add(node.id);
      for (const nextId of graph.dependents.get(node.id) || []) {
        indegree.set(nextId, (indegree.get(nextId) || 0) - 1);
        if ((indegree.get(nextId) || 0) <= 0) {
          const nextNode = graph.nodeMap.get(nextId);
          if (nextNode && !seen.has(nextNode.id) && !next.includes(nextNode)) next.push(nextNode);
        }
      }
    }
    queue = next.sort((a, b) => (a.position?.x || 0) - (b.position?.x || 0) || (a.position?.y || 0) - (b.position?.y || 0));
  }

  const leftovers = graph.executable.filter((node) => !seen.has(node.id));
  if (leftovers.length) levels.push(leftovers);
  return { ...graph, levels };
}

function workflowHasParallel(nodes) {
  return nodes.some((node) => node.type === 'parallel');
}

function parallelSourceExpression(node) {
  if (node.parallelSource === 'manual') {
    return JSON.stringify(String(node.parallelItems || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean));
  }
  if (node.parallelSource === 'args.files') return 'args?.files';
  if (node.parallelSource === 'previous-json') return 'previous';
  if (node.parallelSource === 'auto') return 'args?.items ?? args?.files ?? previous';
  return 'args?.items';
}

function parallelHelpers() {
  return [
    'function toParallelItems(value) {',
    '  if (Array.isArray(value)) return value;',
    '  if (value == null || value === "") return [];',
    '  if (typeof value === "string") {',
    '    try {',
    '      const parsed = JSON.parse(value);',
    '      if (Array.isArray(parsed)) return parsed;',
    '      if (parsed && typeof parsed === "object") return Object.entries(parsed).map(([key, val]) => ({ key, value: val }));',
    '    } catch {}',
    '    return value.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean);',
    '  }',
    '  if (typeof value === "object") return Object.entries(value).map(([key, val]) => ({ key, value: val }));',
    '  return [value];',
    '}',
    '',
    'function formatParallelItem(item) {',
    '  return typeof item === "string" ? item : JSON.stringify(item, null, 2);',
    '}',
    ''
  ];
}

function resultExpression(nodeId) {
  return `results[${jsString(nodeId)}]`;
}

function inputExpression(node, dependencies) {
  const deps = dependencies.get(node.id) || [];
  if (!deps.length) return 'task';
  if (deps.length === 1) return `${resultExpression(deps[0])} ?? ""`;
  return `[${deps.map(resultExpression).join(', ')}].filter(Boolean).join("\\n\\n")`;
}

function phaseForNode(node, incoming, nodeMap) {
  return node.phase || nearestPhaseBefore(node.id, incoming, nodeMap) || '';
}

function agentOptionsSource(node, phase) {
  const model = node.model && node.model !== 'inherit' ? `, model: ${jsString(node.model)}` : '';
  const phaseOption = phase ? `, phase: ${jsString(phase)}` : '';
  return `{ label: ${jsString(node.label || '智能体')}${phaseOption}${model} }`;
}

function appendStepReturn(lines, node, phase, previousExpr, indent = '') {
  const promptSource = node.prompt || '基于任务完成这个智能体步骤：{task}\n\n上游输出：\n{previous}';
  const prompt = promptTemplate(promptSource);
  lines.push(`${indent}const previous = ${previousExpr};`);
  lines.push(`${indent}return agent(\`${prompt}\`, ${agentOptionsSource(node, phase)});`);
}

function appendParallelReturn(lines, node, phase, previousExpr, indent = '') {
  const id = nodeVariable(node);
  const itemName = jsIdentifier(node.itemName || 'item', 'item');
  const maxConcurrency = Math.max(1, Math.min(16, Number.parseInt(node.maxConcurrency, 10) || 16));
  const label = jsTemplate(node.label || '列表并行');
  const model = node.model && node.model !== 'inherit' ? `, model: ${jsString(node.model)}` : '';
  const phaseOption = phase ? `, phase: ${jsString(phase)}` : '';
  const prompt = parallelPromptTemplate(
    node.prompt || '基于用户任务处理这一项：{item}\n\n任务：\n{task}\n\n上游输出：\n{previous}',
    itemName
  );
  lines.push(`${indent}const previous = ${previousExpr};`);
  lines.push(`${indent}const parallelItems_${id} = toParallelItems(${parallelSourceExpression(node)});`);
  lines.push(`${indent}const parallelResults_${id} = [];`);
  lines.push(`${indent}for (let offset = 0; offset < parallelItems_${id}.length; offset += ${maxConcurrency}) {`);
  lines.push(`${indent}  const batch = parallelItems_${id}.slice(offset, offset + ${maxConcurrency});`);
  lines.push(`${indent}  const batchResults = await parallel(batch.map((item, index) => async () => {`);
  if (itemName !== 'item') {
    lines.push(`${indent}    const ${itemName} = item;`);
  }
  lines.push(`${indent}    return agent(\`${prompt}\`, { label: \`${label} \${offset + index + 1}\`${phaseOption}${model} });`);
  lines.push(`${indent}  }));`);
  lines.push(`${indent}  parallelResults_${id}.push(...batchResults);`);
  lines.push(`${indent}}`);
  lines.push(`${indent}if (!parallelItems_${id}.length) return ${jsString(`列表并行「${node.label || '列表并行'}」没有可处理项。`)};`);
  lines.push(`${indent}return parallelResults_${id}.join("\\n\\n");`);
}

function appendNodeReturn(lines, node, phase, previousExpr, indent = '') {
  if (node.type === 'parallel') {
    appendParallelReturn(lines, node, phase, previousExpr, indent);
    return;
  }
  appendStepReturn(lines, node, phase, previousExpr, indent);
}

function appendStepAssign(lines, node, phase, previousExpr) {
  const promptSource = node.prompt || '基于任务完成这个智能体步骤：{task}\n\n上游输出：\n{previous}';
  const prompt = promptTemplate(promptSource);
  lines.push(`previous = ${previousExpr};`);
  lines.push(`previous = await agent(\`${prompt}\`, ${agentOptionsSource(node, phase)});`);
}

function appendParallelAssign(lines, node, phase, previousExpr) {
  const id = nodeVariable(node);
  const itemName = jsIdentifier(node.itemName || 'item', 'item');
  const maxConcurrency = Math.max(1, Math.min(16, Number.parseInt(node.maxConcurrency, 10) || 16));
  const label = jsTemplate(node.label || '列表并行');
  const model = node.model && node.model !== 'inherit' ? `, model: ${jsString(node.model)}` : '';
  const phaseOption = phase ? `, phase: ${jsString(phase)}` : '';
  const prompt = parallelPromptTemplate(
    node.prompt || '基于用户任务处理这一项：{item}\n\n任务：\n{task}\n\n上游输出：\n{previous}',
    itemName
  );
  lines.push(`previous = ${previousExpr};`);
  lines.push(`const parallelItems_${id} = toParallelItems(${parallelSourceExpression(node)});`);
  lines.push(`const parallelResults_${id} = [];`);
  lines.push(`for (let offset = 0; offset < parallelItems_${id}.length; offset += ${maxConcurrency}) {`);
  lines.push(`  const batch = parallelItems_${id}.slice(offset, offset + ${maxConcurrency});`);
  lines.push('  const batchResults = await parallel(batch.map((item, index) => async () => {');
  if (itemName !== 'item') {
    lines.push(`    const ${itemName} = item;`);
  }
  lines.push(`    return agent(\`${prompt}\`, { label: \`${label} \${offset + index + 1}\`${phaseOption}${model} });`);
  lines.push('  }));');
  lines.push(`  parallelResults_${id}.push(...batchResults);`);
  lines.push('}');
  lines.push(`previous = parallelItems_${id}.length ? parallelResults_${id}.join("\\n\\n") : ${jsString(`列表并行「${node.label || '列表并行'}」没有可处理项。`)};`);
}

function appendNodeAssign(lines, node, phase, previousExpr) {
  if (node.type === 'parallel') {
    appendParallelAssign(lines, node, phase, previousExpr);
    return;
  }
  appendStepAssign(lines, node, phase, previousExpr);
}

function generateWorkflowBody(workflow) {
  const normalizedWorkflow = normalizeWorkflowGraph(workflow);
  const executable = executionLevels(normalizedWorkflow);
  const lines = [
    'const task = typeof args === "string" ? args : (args?.task ?? JSON.stringify(args ?? ""));',
    'const results = {};',
    'let previous = "";',
    ''
  ];
  if (workflowHasParallel(executable.executable)) {
    lines.push(...parallelHelpers());
  }

  let emittedAgent = false;
  let currentPhase = '';

  for (const level of executable.levels) {
    const byPhase = new Map();
    for (const node of level) {
      const phase = phaseForNode(node, executable.incoming, executable.nodeMap);
      const key = phase || '';
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key).push(node);
    }

    for (const [phase, nodes] of byPhase.entries()) {
      if (phase && phase !== currentPhase) {
        currentPhase = phase;
        lines.push(`phase(${jsString(currentPhase)});`);
      }
      emittedAgent = true;

      if (nodes.length > 1) {
        const resultVars = nodes.map((node) => `result_${nodeVariable(node)}`);
        lines.push(`const [${resultVars.join(', ')}] = await parallel([`);
        nodes.forEach((node, index) => {
          lines.push('  async () => {');
          appendNodeReturn(lines, node, phase, inputExpression(node, executable.dependencies), '    ');
          lines.push(`  }${index === nodes.length - 1 ? '' : ','}`);
        });
        lines.push(']);');
        nodes.forEach((node, index) => {
          lines.push(`${resultExpression(node.id)} = ${resultVars[index]};`);
        });
        lines.push(`previous = [${resultVars.join(', ')}].filter(Boolean).join("\\n\\n");`);
        lines.push('');
        continue;
      }

      const node = nodes[0];
      appendNodeAssign(lines, node, phase, inputExpression(node, executable.dependencies));
      lines.push(`${resultExpression(node.id)} = previous;`);
      lines.push('');
    }
  }

  if (!emittedAgent) {
    currentPhase = '完成';
    lines.push('phase("完成");');
    lines.push('previous = task;');
    lines.push('');
  }

  lines.push('return previous;');
  return `${lines.join('\n')}\n`;
}

function generateWorkflowScript(workflow) {
  const normalizedWorkflow = normalizeWorkflowGraph(workflow);
  return [
    metaBlock(normalizedWorkflow).trimEnd(),
    '',
    graphBlock(normalizedWorkflow).trimEnd(),
    '',
    generateWorkflowBody(normalizedWorkflow).trimEnd(),
    ''
  ].join('\n');
}

function composeScriptWithGraph(workflow, script) {
  const body = stripWorkflowMeta(stripDashboardGraph(script)).trim();
  return [
    metaBlock(workflow).trimEnd(),
    '',
    graphBlock(workflow).trimEnd(),
    '',
    body || generateWorkflowBody(workflow).trimEnd(),
    ''
  ].join('\n');
}

function composeRawScript(workflow, script) {
  const cleaned = stripDashboardGraph(script).trimStart();
  if (/^export\s+const\s+meta\s*=/.test(cleaned)) return `${cleaned.trimEnd()}\n`;
  return `${metaBlock(workflow)}${cleaned.trimEnd()}\n`;
}

async function readOfficialWorkflows(projectRoot) {
  const root = projectWorkflowsDir(projectRoot);
  const files = (await listFilesRecursive(root)).filter(isWorkflowScript).sort();
  const workflows = [];
  for (const file of files) {
    const script = await fsp.readFile(file, 'utf8');
    workflows.push({
      ...parseWorkflowScript(script, workflowCommandName(file)),
      file
    });
  }
  return workflows;
}

async function writeOfficialWorkflow(projectRoot, input, previousFile) {
  const commandName = slugify(input.commandName || input.id || input.name, 'workflow');
  const file = workflowScriptPath(projectRoot, commandName);
  const workflow = normalizeWorkflowGraph({ ...input, commandName });
  const script = input.script && input.script.trim()
    ? (input.rawScriptEdited ? composeRawScript(workflow, input.script) : composeScriptWithGraph(workflow, input.script))
    : generateWorkflowScript(workflow);

  await ensureDir(path.dirname(file));
  if (previousFile && path.resolve(previousFile) !== path.resolve(file)) {
    await removeIfExists(previousFile);
  }
  await writeFileAtomic(file, script);

  return {
    ...parseWorkflowScript(script, commandName),
    file
  };
}

async function removeOfficialWorkflow(file) {
  await removeIfExists(file);
}

function defaultOfficialWorkflow() {
  const name = 'implement-and-verify';
  const workflow = {
    id: name,
    commandName: name,
    name: '实现并验证',
    description: '用 Claude Code 编排规划、并行实现、审核和验证。',
    nodes: [
      { id: 'start', type: 'start', label: '任务输入', position: { x: 80, y: 210 } },
      { id: createId('phase'), type: 'phase', label: '规划', prompt: '理解任务并拆解执行路径。', position: { x: 310, y: 92 } },
      {
        id: 'planner',
        type: 'step',
        label: '任务规划师',
        agentRole: 'planner',
        model: 'sonnet',
        prompt: '你是任务规划师。分析当前项目，并为这个任务产出清晰的实现计划。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
        position: { x: 330, y: 190 }
      },
      {
        id: 'developer',
        type: 'step',
        label: '开发者',
        agentRole: 'developer',
        model: 'sonnet',
        phase: '实现',
        prompt: '你是开发者。基于规划和上游上下文，在当前项目中完成必要修改。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
        position: { x: 610, y: 130 }
      },
      {
        id: 'tester',
        type: 'step',
        label: '测试员',
        agentRole: 'tester',
        model: 'sonnet',
        phase: '验证',
        prompt: '你是测试员。根据当前项目选择合适检查或测试命令执行，并总结通过/失败情况。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
        position: { x: 610, y: 270 }
      },
      {
        id: 'reviewer',
        type: 'step',
        label: '审核员',
        agentRole: 'reviewer',
        model: 'sonnet',
        phase: '验收',
        prompt: '你是审核员。综合上游实现和测试结果，判断是否满足用户任务，列出风险和最终结论。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
        position: { x: 900, y: 200 }
      },
      { id: 'end', type: 'end', label: '返回结果', position: { x: 1190, y: 220 } }
    ]
  };
  workflow.edges = [
    { id: 'edge_0', source: 'start', target: workflow.nodes[1].id },
    { id: 'edge_1', source: workflow.nodes[1].id, target: 'planner' },
    { id: 'edge_2', source: 'planner', target: 'developer' },
    { id: 'edge_3', source: 'planner', target: 'tester' },
    { id: 'edge_4', source: 'developer', target: 'reviewer' },
    { id: 'edge_5', source: 'tester', target: 'reviewer' },
    { id: 'edge_6', source: 'reviewer', target: 'end' }
  ];
  return {
    ...workflow,
    script: generateWorkflowScript(workflow)
  };
}

function blankOfficialWorkflow(input = {}) {
  const commandName = slugify(input.commandName || input.id || '', `workflow-${Date.now().toString(36)}`);
  const workflow = {
    id: commandName,
    commandName,
    name: input.name || '新建工作流',
    description: input.description || '可视化 Claude Code 工作流。',
    nodes: [
      { id: 'start', type: 'start', label: '任务输入', position: { x: 80, y: 210 } },
      { id: 'end', type: 'end', label: '返回结果', position: { x: 470, y: 210 } }
    ],
    edges: [
      { id: 'edge_0', source: 'start', target: 'end' }
    ]
  };
  return {
    ...workflow,
    script: generateWorkflowScript(workflow)
  };
}

module.exports = {
  blankOfficialWorkflow,
  defaultOfficialWorkflow,
  extractDashboardGraph,
  generateWorkflowScript,
  normalizeWorkflowGraph,
  parseWorkflowScript,
  projectWorkflowsDir,
  readOfficialWorkflows,
  removeOfficialWorkflow,
  stripDashboardGraph,
  writeOfficialWorkflow,
  workflowScriptPath
};
