import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

window.addEventListener('error', (event) => {
  window.__ultracodeLastError = event.error?.stack || event.message || String(event.error || '');
});
window.addEventListener('unhandledrejection', (event) => {
  window.__ultracodeLastError = event.reason?.stack || event.reason?.message || String(event.reason || '');
});

function normalizeAppBasePath(value) {
  let basePath = String(value || '/').trim();
  if (!basePath || basePath === '/') return '/';
  if (!basePath.startsWith('/')) basePath = `/${basePath}`;
  if (!basePath.endsWith('/')) basePath = `${basePath}/`;
  return basePath.replace(/\/+/g, '/');
}

const APP_BASE_PATH = normalizeAppBasePath(window.__ULTRACODE_BASE_PATH__ || '/');

function appPath(path) {
  return `${APP_BASE_PATH}${String(path || '').replace(/^\/+/, '')}`;
}

function wsUrl(path) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${appPath(path || 'ws')}`;
}

const NODE_ROLE_LABELS = {
  general: '自定义提示词',
  planner: '规划任务',
  developer: '实现修改',
  reviewer: '审查结果',
  tester: '运行验证',
  debugger: '定位修复',
  documenter: '整理文档',
  decider: '判断/验收'
};

const NODE_ROLE_ICONS = {
  general: 'A',
  planner: 'A',
  developer: 'A',
  reviewer: 'A',
  tester: 'A',
  debugger: 'A',
  documenter: 'A',
  decider: 'A'
};

const NODE_TYPE_LABELS = {
  start: '入口参数 args',
  step: '调用智能体 agent()',
  parallel: '列表并行 parallel()',
  phase: '阶段标记 phase()',
  end: '返回结果 return'
};

const NODE_COLORS = {
  start: '#22c55e',
  step: '#38bdf8',
  parallel: '#2dd4bf',
  phase: '#60a5fa',
  end: '#f87171'
};

const MODEL_OPTIONS = ['inherit', 'sonnet', 'opus', 'haiku', 'fable'];

function escapeText(value) {
  return String(value ?? '');
}

function newId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

async function api(path, options = {}) {
  const response = await fetch(appPath(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function statusText(status) {
  return {
    pending: '等待中',
    running: '运行中',
    completed: '已完成',
    failed: '失败'
  }[status || 'pending'] || '等待中';
}

function roleLabel(role) {
  return NODE_ROLE_LABELS[role || 'general'] || NODE_ROLE_LABELS.general;
}

function roleIcon(node) {
  if (node.type !== 'step') {
    if (node.type === 'parallel') return '并';
    if (node.type === 'start') return 'S';
    if (node.type === 'end') return 'E';
    return '段';
  }
  return NODE_ROLE_ICONS[node.agentRole || 'general'] || 'A';
}

function nodeAccent(node) {
  if (node.type === 'step') {
    return {
      general: '#38bdf8',
      planner: '#60a5fa',
      developer: '#22c55e',
      reviewer: '#a78bfa',
      tester: '#2dd4bf',
      debugger: '#fb7185',
      documenter: '#f59e0b',
      decider: '#f97316'
    }[node.agentRole || 'general'] || '#38bdf8';
  }
  return NODE_COLORS[node.type] || '#38bdf8';
}

function parallelSourceText(source) {
  return {
    'args.items': '入参 args.items',
    'args.files': '入参 args.files',
    'previous-json': '上游 JSON',
    manual: '手动列表',
    auto: '自动识别'
  }[source || 'args.items'] || '入参 args.items';
}

function nodeSummary(node) {
  if (node.type === 'start') return '运行时注入 args.task';
  if (node.type === 'end') return 'return previous';
  if (node.type === 'parallel') return `${parallelSourceText(node.parallelSource)} · 同模板 · 最多并发 ${node.maxConcurrency || 16}`;
  if (node.type === 'phase') return node.prompt || '生成 phase("阶段名")';
  if (node.type === 'step') return `${roleLabel(node.agentRole)} · agent()`;
  return node.output || node.prompt || '';
}

function defaultPromptForType(type) {
  if (type === 'parallel') {
    return '你是一个并行子 agent，请只处理当前 item。\n\n用户任务：\n{task}\n\n当前 item：\n{item}\n\n上游输出：\n{previous}\n\n完成后返回可合并的结果。';
  }
  if (type === 'step') {
    return '你是这个 workflow 中的一个子 agent。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}\n\n请完成本节点职责，并返回清晰结果。';
  }
  return '';
}

function defaultPromptForRole(role) {
  return {
    planner: '你是任务规划师。阅读用户任务和当前项目上下文，拆解目标、风险、边界，并给后续 agent 一份可执行计划。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
    developer: '你是开发者。基于任务和上游计划，在当前项目中完成必要修改；如果需要运行命令，请通过 Claude Code 工具执行并总结结果。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
    reviewer: '你是审核员。审查上游结果是否满足任务，指出风险、遗漏和需要修复的点；如果可以验收，给出明确通过结论。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
    tester: '你是测试员。根据当前项目选择合适的检查或测试命令执行，并总结通过、失败和后续建议。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
    debugger: '你是修复专家。根据上游失败信息定位问题，进行最小必要修复，并说明修复依据。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
    documenter: '你是文档员。把上游结果整理成清晰文档、变更说明或交付摘要。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}',
    decider: '你是验收判断 agent。阅读用户任务和上游输出，判断结果是否满足目标；返回“通过”或“不通过”，并说明原因。\n\n用户任务：\n{task}\n\n上游输出：\n{previous}'
  }[role] || defaultPromptForType('step');
}

function roleTemplateHelp(role) {
  if (role === 'decider') {
    return '这是一个“验收/判断”提示词模板，不是 if/else 分支。保存后仍然是 agent()；多条出线会生成并行分支，不会按“通过/不通过”自动分流。';
  }
  if (role === 'general') return '不套预设模板，直接编辑下方 agent() 提示词。';
  return '这些不是 Claude Code 官方角色，只是帮你快速填充 agent() 提示词；保存后仍然生成普通 agent()。';
}

function officialNodeCode(type) {
  return {
    start: 'args / args.task',
    phase: 'phase("阶段名")',
    step: 'await agent("提示词", { label })',
    parallel: 'await parallel(items.map(item => agent(...)))',
    end: 'return previous'
  }[type] || 'await agent("提示词")';
}

function officialNodeHelp(type) {
  return {
    start: '官方全局入参。底部输入的任务会作为 args.task 传入 workflow；它不是可执行步骤。',
    phase: '官方进度标记。只影响 /workflows 进度视图，不启动 agent，也不改变上游输出。阶段在画布中作为分组标题；在 agent 的“归入阶段”填同名即可关联阶段。',
    step: '官方子 agent 调用。这个节点会启动一个独立 agent，真正执行的是下面的提示词。从一个节点连到多个下游 agent 时，这些下游会生成 parallel([...]) 并行执行。',
    parallel: '列表并行节点用于同一提示词模板处理多个 item。不同提示词的并行不需要这个节点，直接从上游连到多个 agent 节点即可。',
    end: '脚本返回值。这里返回最后一个可执行节点的输出，作为 workflow 的最终结果。'
  }[type] || '官方 workflow 脚本构件。';
}

function HelpTip({ text }) {
  return <span className="help-tip" tabIndex="0" aria-label={text} data-tip={text}>?</span>;
}

function FieldLabel({ children, help }) {
  return <label>{children}{help ? <HelpTip text={help} /> : null}</label>;
}

function isExecutableNode(node) {
  return node?.type === 'step' || node?.type === 'parallel';
}

function graphAdjacency(workflow) {
  const nodes = workflow?.nodes || [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of workflow?.edges || []) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  }
  return { nodeMap, incoming, outgoing };
}

function nearestPhaseBefore(nodeId, adjacency, seen = new Set()) {
  if (seen.has(nodeId)) return '';
  seen.add(nodeId);
  for (const edge of adjacency.incoming.get(nodeId) || []) {
    const prev = adjacency.nodeMap.get(edge.source);
    if (!prev) continue;
    if (prev.type === 'phase' && prev.label) return prev.label;
    if (!isExecutableNode(prev)) {
      const nested = nearestPhaseBefore(prev.id, adjacency, seen);
      if (nested) return nested;
    }
  }
  return '';
}

function effectiveNodePhase(node, adjacency) {
  if (!isExecutableNode(node)) return '';
  return String(node.phase || nearestPhaseBefore(node.id, adjacency) || '').trim();
}

function isPhaseNodeId(nodeMap, nodeId) {
  return nodeMap.get(nodeId)?.type === 'phase';
}

function downstreamVisibleTargets(nodeId, adjacency, seen = new Set()) {
  if (seen.has(nodeId)) return [];
  seen.add(nodeId);
  const targets = [];
  for (const edge of adjacency.outgoing.get(nodeId) || []) {
    const target = adjacency.nodeMap.get(edge.target);
    if (!target) continue;
    if (target.type === 'phase') {
      targets.push(...downstreamVisibleTargets(target.id, adjacency, seen));
      continue;
    }
    targets.push(target.id);
  }
  return [...new Set(targets)];
}

function visibleWorkflowEdges(workflow) {
  const adjacency = graphAdjacency(workflow);
  const visible = [];
  const seen = new Set();

  for (const edge of workflow?.edges || []) {
    const source = adjacency.nodeMap.get(edge.source);
    const target = adjacency.nodeMap.get(edge.target);
    if (!source || !target || source.id === target.id) continue;
    if (target.type !== 'phase') {
      if (source.type === 'phase') continue;
      const key = `${source.id}->${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      visible.push({ ...edge, synthetic: false });
    }
  }

  for (const edge of workflow?.edges || []) {
    const source = adjacency.nodeMap.get(edge.source);
    const target = adjacency.nodeMap.get(edge.target);
    if (!source || !target || source.id === target.id || source.type === 'phase' || target.type !== 'phase') continue;
    for (const targetId of downstreamVisibleTargets(target.id, adjacency)) {
      if (targetId === source.id || isPhaseNodeId(adjacency.nodeMap, targetId)) continue;
      const key = `${source.id}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      visible.push({
        id: `phase-pass-${source.id}-${target.id}-${targetId}`,
        source: source.id,
        target: targetId,
        synthetic: true
      });
    }
  }

  return visible;
}

function isVirtualEdge(edgeOrId) {
  const id = typeof edgeOrId === 'string' ? edgeOrId : edgeOrId?.id;
  return String(id || '').startsWith('phase-link-') || String(id || '').startsWith('phase-pass-');
}

function cleanWorkflowGraph(workflow) {
  if (!workflow) return workflow;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set();
  const edges = [];
  for (const edge of workflow.edges || []) {
    const key = `${edge.source}->${edge.target}`;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target || seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  return { ...workflow, nodes, edges };
}

function graphIssues(workflow) {
  if (!workflow) return [];
  const nodes = workflow.nodes || [];
  if (!nodes.length) return ['当前工作流还没有节点。'];
  const issues = [];
  if (!nodes.some((node) => node.type === 'start')) issues.push('缺少开始节点，无法形成从任务输入到完成的闭环。');
  if (!nodes.some((node) => node.type === 'end')) issues.push('缺少结束节点，无法形成从任务输入到完成的闭环。');
  if (!nodes.some((node) => node.type === 'step' || node.type === 'parallel')) {
    issues.push('至少添加一个调用智能体 agent() 或列表并行 parallel()。');
  }
  return issues;
}

function validateConnection(workflow, sourceId, targetId) {
  const source = workflow?.nodes?.find((node) => node.id === sourceId);
  const target = workflow?.nodes?.find((node) => node.id === targetId);
  if (!workflow || !source || !target) return { ok: false, message: '连线失败：节点不存在。' };
  if (sourceId === targetId) return { ok: false, message: '不能把节点连接到自己。' };
  if (source.type === 'end') return { ok: false, message: '结束节点不能作为连线起点。' };
  if (target.type === 'start') return { ok: false, message: '开始节点不能作为连线终点。' };
  if ((workflow.edges || []).some((edge) => edge.source === sourceId && edge.target === targetId)) {
    return { ok: false, message: '这条连线已经存在。' };
  }
  return { ok: true };
}

function flowNodeType(node) {
  if (node.type === 'phase') return 'phaseNode';
  return 'workflowNode';
}

function WorkflowNode({ data, selected }) {
  const node = data.node;
  const accent = nodeAccent(node);
  const phase = data.phase || '';
  const statusColor = {
    pending: '#7c8aa0',
    running: '#38bdf8',
    completed: '#6ee782',
    failed: '#fb7185'
  }[node.status || 'pending'] || '#7c8aa0';

  return (
    <div className={`rf-node-card ${selected ? 'selected' : ''} ${node.type}`} style={{ '--node-accent': accent, '--node-status': statusColor }}>
      {node.type !== 'start' ? <Handle id="in" type="target" position={Position.Left} className="rf-handle in" /> : null}
      <div className="rf-status-bar" />
      <div className="rf-node-body">
        <div className="rf-node-icon">{roleIcon(node)}</div>
        <div className="rf-node-main">
          <div className="rf-node-title">{node.label || NODE_TYPE_LABELS[node.type] || '节点'}</div>
          <div className="rf-node-status">{statusText(node.status)}</div>
        </div>
        <span className="rf-node-dot" />
      </div>
      {phase ? <div className="rf-node-phase">阶段：{phase}</div> : null}
      <div className="rf-node-summary">{nodeSummary(node)}</div>
      {node.type !== 'end' ? <Handle id="out" type="source" position={Position.Right} className="rf-handle out" /> : null}
    </div>
  );
}

function PhaseNode({ data, selected }) {
  const node = data.node;
  return (
    <div className={`rf-phase-node ${selected ? 'selected' : ''}`}>
      <span className="rf-phase-kicker">phase()</span>
      <span className="rf-phase-title">{node.label || '阶段'}</span>
    </div>
  );
}

const NODE_TYPES = {
  workflowNode: memo(WorkflowNode),
  phaseNode: memo(PhaseNode)
};

const DEFAULT_EDGE_OPTIONS = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, color: '#5f7695' },
  style: { stroke: '#5f7695', strokeWidth: 2 }
};

function toFlowNodes(workflow) {
  const adjacency = graphAdjacency(workflow);
  return (workflow?.nodes || []).map((node) => ({
    id: node.id,
    type: flowNodeType(node),
    position: node.position || { x: 0, y: 0 },
    width: 230,
    height: node.type === 'phase' ? 44 : 100,
    measured: {
      width: 230,
      height: node.type === 'phase' ? 44 : 100
    },
    data: {
      node,
      phase: effectiveNodePhase(node, adjacency)
    }
  }));
}

function toFlowEdges(workflow) {
  return visibleWorkflowEdges(workflow).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: 'out',
    targetHandle: 'in',
    ...DEFAULT_EDGE_OPTIONS,
    selectable: !edge.synthetic,
    focusable: !edge.synthetic,
    interactionWidth: edge.synthetic ? 0 : 20,
    style: edge.synthetic
      ? { stroke: '#6f85a5', strokeWidth: 1.8, opacity: 0.72 }
      : DEFAULT_EDGE_OPTIONS.style
  }));
}

function cloneWorkflow(workflow) {
  return {
    ...workflow,
    nodes: (workflow.nodes || []).map((node) => ({ ...node, position: { ...(node.position || {}) } })),
    edges: (workflow.edges || []).map((edge) => ({ ...edge }))
  };
}

function updateNodeDefaults(node, type) {
  const next = { ...node, type };
  next.label ||= NODE_TYPE_LABELS[type] || '智能体';
  next.model ||= 'inherit';
  next.agentRole ||= 'general';
  next.phase ||= '';
  if (type === 'parallel') {
    next.label = node.label || '列表并行';
    next.prompt ||= defaultPromptForType('parallel');
    next.parallelSource ||= 'args.items';
    next.parallelItems ||= '';
    next.itemName ||= 'item';
    next.maxConcurrency ||= 16;
  }
  if (type === 'step') next.prompt ||= defaultPromptForType('step');
  return next;
}

function createNode(type, position) {
  const labels = {
    step: '智能体',
    parallel: '列表并行',
    phase: '阶段',
    end: '返回结果',
    start: '输入 args'
  };
  return {
    id: newId('node'),
    type,
    label: labels[type] || '智能体',
    position,
    prompt: defaultPromptForType(type),
    systemPrompt: '',
    model: 'inherit',
    agentRole: 'general',
    phase: '',
    parallelSource: 'args.items',
    parallelItems: '',
    itemName: 'item',
    maxConcurrency: 16
  };
}

function AutoFit({ trigger }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    let innerFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => fitView({ padding: 0.2, duration: 260 }));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (innerFrame) window.cancelAnimationFrame(innerFrame);
    };
  }, [fitView, trigger]);
  return null;
}

function Inspector({
  workflow,
  selectedNode,
  onWorkflowChange,
  onNodeChange,
  onClose
}) {
  if (!workflow) return <aside className="inspector"><div className="empty">未选择工作流。</div></aside>;

  if (!selectedNode) {
    return (
      <aside className="inspector">
        <div className="inspector-head">
          <h2 className="section-title">工作流</h2>
          <button className="icon" onClick={onClose} title="收起属性">×</button>
        </div>
        <div className="field">
          <FieldLabel help="写入 export const meta.name，用于 Claude Code 识别这个 workflow。">名称</FieldLabel>
          <input value={workflow.name || ''} onChange={(event) => onWorkflowChange({ name: event.target.value })} />
        </div>
        <div className="field">
          <FieldLabel help="保存后成为 Claude Code 里的斜杠命令名，例如 /review-pr。">命令名</FieldLabel>
          <input value={workflow.commandName || workflow.id || ''} onChange={(event) => onWorkflowChange({ commandName: event.target.value, id: event.target.value })} />
        </div>
        <div className="field">
          <FieldLabel help="写入 meta.description，用于说明这个 workflow 什么时候使用。">描述</FieldLabel>
          <textarea value={workflow.description || ''} onChange={(event) => onWorkflowChange({ description: event.target.value })} />
        </div>
        <div className="field">
          <FieldLabel help="这是实际保存到 .claude/workflows/<name>.js 的官方 JavaScript workflow。手动编辑后会以源码为准。">官方 Workflow 脚本源码</FieldLabel>
          <textarea className="source-editor" value={workflow.script || ''} onChange={(event) => onWorkflowChange({ script: event.target.value, rawScriptEdited: true }, { keepScript: true })} />
        </div>
        <div className="empty">画布会保存到同一个官方 workflow 脚本中；源码手动编辑后将以源码为准。</div>
      </aside>
    );
  }

  const isStep = selectedNode.type === 'step';
  const isPhase = selectedNode.type === 'phase';
  const isParallel = selectedNode.type === 'parallel';

  const updateType = (type) => {
    onNodeChange(updateNodeDefaults(selectedNode, type));
  };

  const updateRole = (role) => {
    const oldDefault = defaultPromptForRole(selectedNode.agentRole);
    const next = { ...selectedNode, agentRole: role };
    if (!selectedNode.prompt || selectedNode.prompt === defaultPromptForType('step') || selectedNode.prompt === oldDefault) {
      next.prompt = defaultPromptForRole(role);
    }
    onNodeChange(next);
  };

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <h2 className="section-title">{NODE_TYPE_LABELS[selectedNode.type] || '节点'}</h2>
        <button className="icon" onClick={onClose} title="收起属性">×</button>
      </div>
      <div className="split">
        <div className="field">
          <FieldLabel help={`保存为官方代码：${officialNodeCode(selectedNode.type)}。${officialNodeHelp(selectedNode.type)}`}>脚本构件（官方）</FieldLabel>
          <select value={selectedNode.type} onChange={(event) => updateType(event.target.value)}>
            <option value="start">入口：args 入参</option>
            <option value="phase">阶段：phase() 进度标记</option>
            <option value="step">执行：agent() 子智能体</option>
            <option value="parallel">列表并行：同一模板跑多个 item</option>
            <option value="end">结束：return 返回结果</option>
          </select>
        </div>
        <div className="field">
          <FieldLabel help="节点显示名称；对 agent() 会写入 label，对 phase() 会作为阶段名。">名称</FieldLabel>
          <input value={selectedNode.label || ''} onChange={(event) => onNodeChange({ ...selectedNode, label: event.target.value })} />
        </div>
      </div>

      {selectedNode.type === 'start' ? <div className="empty">执行时，底部输入会作为 <code>args.task</code> 传给这个 workflow。</div> : null}
      {selectedNode.type === 'end' ? <div className="empty">保存时生成 <code>return previous</code>，返回最后一个可执行节点的结果。</div> : null}

      {isPhase ? (
          <div className="field">
            <FieldLabel help="显示在 Claude Code workflow 进度视图里的阶段说明；不会启动 agent，也不会改变数据流。阶段节点只是画布分组标题，具体 agent 通过“归入阶段”字段关联。">阶段详情</FieldLabel>
          <textarea value={selectedNode.prompt || ''} onChange={(event) => onNodeChange({ ...selectedNode, prompt: event.target.value })} />
        </div>
      ) : null}

      {isStep ? (
        <>
          <div className="split">
            <div className="field">
              <FieldLabel help={roleTemplateHelp(selectedNode.agentRole || 'general')}>提示词模板（非官方）</FieldLabel>
              <select value={selectedNode.agentRole || 'general'} onChange={(event) => updateRole(event.target.value)}>
                {Object.entries(NODE_ROLE_LABELS).map(([role, label]) => (
                  <option value={role} key={role}>{role === 'general' ? label : `套用模板：${label}`}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <FieldLabel help="留“继承”就是使用当前 Claude Code 会话模型；选择模型会写入 agent() 选项。">模型（可选）</FieldLabel>
              <select value={selectedNode.model || 'inherit'} onChange={(event) => onNodeChange({ ...selectedNode, model: event.target.value })}>
                {MODEL_OPTIONS.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <FieldLabel help="保存时会作为 agent(..., { phase })，用于 Claude Code 的 workflow 进度分组。填写与阶段标记同名的阶段即可归组。">归入阶段</FieldLabel>
            <input value={selectedNode.phase || ''} placeholder="例如：规划、实现、验证；与阶段标记同名即可归组" onChange={(event) => onNodeChange({ ...selectedNode, phase: event.target.value })} />
          </div>
          <div className="field">
            <FieldLabel help="这是这个节点真正交给子 agent 的任务说明。可用 {task}=用户输入，{previous}=上游节点输出。">agent() 提示词</FieldLabel>
            <textarea value={selectedNode.prompt || ''} onChange={(event) => onNodeChange({ ...selectedNode, prompt: event.target.value })} />
          </div>
        </>
      ) : null}

      {isParallel ? (
        <>
          <div className="split">
            <div className="field">
              <FieldLabel help="留“继承”就是使用当前 Claude Code 会话模型。">模型（可选）</FieldLabel>
              <select value={selectedNode.model || 'inherit'} onChange={(event) => onNodeChange({ ...selectedNode, model: event.target.value })}>
                {MODEL_OPTIONS.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </div>
            <div className="field">
              <FieldLabel help="用于 /workflows 进度视图分组。填写与阶段标记同名的阶段即可归组。">归入阶段</FieldLabel>
              <input value={selectedNode.phase || ''} onChange={(event) => onNodeChange({ ...selectedNode, phase: event.target.value })} />
            </div>
          </div>
          <div className="split">
            <div className="field">
              <FieldLabel help="这里必须得到一个列表；列表里的每一项都会用同一提示词模板启动一个 agent。不同提示词的并行请直接创建多个 agent 节点并从上游分别连线。">列表来源</FieldLabel>
              <select value={selectedNode.parallelSource || 'args.items'} onChange={(event) => onNodeChange({ ...selectedNode, parallelSource: event.target.value })}>
                <option value="args.items">运行入参 args.items</option>
                <option value="args.files">运行入参 args.files</option>
                <option value="previous-json">上游 JSON 数组</option>
                <option value="manual">手动列表</option>
                <option value="auto">自动：args 或上游</option>
              </select>
            </div>
            <div className="field">
              <FieldLabel help="官方并发上限是 16；本面板会自动限制到 16。">最大并发</FieldLabel>
              <input type="number" min="1" max="16" value={selectedNode.maxConcurrency || 16} onChange={(event) => onNodeChange({ ...selectedNode, maxConcurrency: Math.max(1, Math.min(16, Number.parseInt(event.target.value, 10) || 16)) })} />
            </div>
          </div>
          <div className="field">
            <FieldLabel help="仅当列表来源选择“手动列表”时使用；每行一项，每一行都会变成一个并行 agent 的 item。">手动列表</FieldLabel>
            <textarea value={selectedNode.parallelItems || ''} onChange={(event) => onNodeChange({ ...selectedNode, parallelItems: event.target.value })} />
          </div>
          <div className="field">
            <FieldLabel help="列表并行节点不是一个“大 agent”，而是按列表批量生成多个 agent；这些 agent 使用同一模板，但 {item} 不同。可用 {item}、{task}、{previous}。">每个 item 的 agent() 提示词</FieldLabel>
            <textarea value={selectedNode.prompt || ''} onChange={(event) => onNodeChange({ ...selectedNode, prompt: event.target.value })} />
          </div>
        </>
      ) : null}
    </aside>
  );
}

function App() {
  const [context, setContext] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [fitTrigger, setFitTrigger] = useState(0);
  const logRef = useRef(null);

  const activeWorkflow = useMemo(() => {
    return workflows.find((workflow) => workflow.id === activeId) || workflows[0] || null;
  }, [workflows, activeId]);

  const selectedNode = useMemo(() => {
    return activeWorkflow?.nodes?.find((node) => node.id === selectedNodeId) || null;
  }, [activeWorkflow, selectedNodeId]);

  const flowNodes = useMemo(() => toFlowNodes(activeWorkflow), [activeWorkflow]);
  const flowEdges = useMemo(() => toFlowEdges(activeWorkflow), [activeWorkflow]);
  const issues = useMemo(() => graphIssues(activeWorkflow), [activeWorkflow]);

  const addLog = useCallback((level, text) => {
    setLogs((items) => [...items, { level, text, at: new Date().toISOString() }]);
  }, []);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const loadAll = useCallback(async () => {
    const [contextData, workflowData] = await Promise.all([
      api('/api/context'),
      api('/api/workflows')
    ]);
    setContext(contextData);
    setWorkflows(workflowData.workflows || []);
    setActiveId((current) => current || workflowData.workflows?.[0]?.id || null);
    setDirty(false);
    setFitTrigger((value) => value + 1);
  }, []);

  useEffect(() => {
    loadAll().catch((error) => {
      setNotice(`加载失败：${error.message}`);
      addLog('stderr', `加载失败：${error.message}\n`);
    });
  }, [loadAll, addLog]);

  useEffect(() => {
    const socket = new WebSocket(wsUrl('ws'));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'workflow.output') {
        addLog(message.payload?.stream === 'stderr' ? 'stderr' : 'stdout', message.payload?.text || '');
      }
      if (message.type === 'workflow.runStarted') {
        setRunning(true);
        setRunId(message.payload?.id || '');
        addLog('event', `运行开始：${message.payload?.workflowName || ''}\n`);
      }
      if (message.type === 'workflow.runCompleted') {
        setRunning(false);
        addLog('event', '运行完成。\n');
      }
      if (message.type === 'workflow.runFailed') {
        setRunning(false);
        addLog('stderr', `运行失败：${message.payload?.error || '未知错误'}\n`);
      }
    });
    return () => socket.close();
  }, [addLog]);

  const updateActiveWorkflow = useCallback((updater, options = {}) => {
    if (!activeWorkflow) return;
    setWorkflows((items) => items.map((workflow) => {
      if (workflow.id !== activeWorkflow.id) return workflow;
      const draft = cloneWorkflow(workflow);
      const updated = typeof updater === 'function' ? updater(draft) : { ...draft, ...updater };
      return cleanWorkflowGraph(options.keepScript ? updated : { ...updated, script: '' });
    }));
    setDirty(true);
  }, [activeWorkflow]);

  const updateWorkflowFields = useCallback((patch, options) => {
    updateActiveWorkflow((workflow) => ({ ...workflow, ...patch }), options);
  }, [updateActiveWorkflow]);

  const updateNode = useCallback((nextNode) => {
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === nextNode.id ? { ...nextNode } : node)
    }));
  }, [updateActiveWorkflow]);

  const onNodesChange = useCallback((changes) => {
    if (!activeWorkflow) return;
    if (changes.some((change) => change.type === 'position')) {
      const nextFlowNodes = applyNodeChanges(changes, toFlowNodes(activeWorkflow));
      const positionMap = new Map(nextFlowNodes.map((node) => [node.id, node.position]));
      updateActiveWorkflow((workflow) => ({
        ...workflow,
        nodes: workflow.nodes.map((node) => {
          const position = positionMap.get(node.id);
          return position ? { ...node, position } : node;
        })
      }));
    }
  }, [activeWorkflow, updateActiveWorkflow]);

  const onConnect = useCallback((connection) => {
    const validation = validateConnection(activeWorkflow, connection.source, connection.target);
    if (!validation.ok) {
      setNotice(validation.message);
      return;
    }
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      edges: addEdge({
        id: newId('edge'),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle || 'out',
        targetHandle: connection.targetHandle || 'in'
      }, workflow.edges || [])
    }));
  }, [activeWorkflow, updateActiveWorkflow]);

  const onEdgesDelete = useCallback((deleted) => {
    const ids = new Set(deleted.filter((edge) => !isVirtualEdge(edge)).map((edge) => edge.id));
    if (!ids.size) return;
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      edges: workflow.edges.filter((edge) => !ids.has(edge.id))
    }));
  }, [updateActiveWorkflow]);

  const onEdgesChange = useCallback((changes) => {
    const selection = changes.find((change) => change.type === 'select' && change.selected && !isVirtualEdge(change.id));
    if (selection) {
      setSelectedEdgeId(selection.id);
      setSelectedNodeId(null);
    }
    const nextEdges = applyEdgeChanges(changes, flowEdges);
    const removed = new Set(
      flowEdges
        .filter((edge) => !nextEdges.some((next) => next.id === edge.id))
        .filter((edge) => !isVirtualEdge(edge))
        .map((edge) => edge.id)
    );
    if (removed.size) {
      updateActiveWorkflow((workflow) => ({
        ...workflow,
        edges: workflow.edges.filter((edge) => !removed.has(edge.id))
      }));
    }
  }, [flowEdges, updateActiveWorkflow]);

  const onNodeDoubleClick = useCallback((_event, node) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
  }, []);

  const addNodeToWorkflow = useCallback((type) => {
    if (!activeWorkflow) return;
    const index = activeWorkflow.nodes?.length || 0;
    const node = createNode(type, {
      x: 180 + (index % 4) * 280,
      y: 120 + Math.floor(index / 4) * 140
    });
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      nodes: [...(workflow.nodes || []), node]
    }));
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
  }, [activeWorkflow, updateActiveWorkflow]);

  const deleteSelected = useCallback(() => {
    if (!activeWorkflow) return;
    if (selectedEdgeId) {
      updateActiveWorkflow((workflow) => ({
        ...workflow,
        edges: workflow.edges.filter((edge) => edge.id !== selectedEdgeId)
      }));
      setSelectedEdgeId(null);
      return;
    }
    if (!selectedNodeId) return;
    const node = activeWorkflow.nodes.find((item) => item.id === selectedNodeId);
    if (node?.type === 'start' && activeWorkflow.nodes.filter((item) => item.type === 'start').length <= 1) {
      setNotice('至少需要保留一个开始节点。');
      return;
    }
    if (node?.type === 'end' && activeWorkflow.nodes.filter((item) => item.type === 'end').length <= 1) {
      setNotice('至少需要保留一个结束节点。');
      return;
    }
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.filter((item) => item.id !== selectedNodeId),
      edges: workflow.edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId)
    }));
    setSelectedNodeId(null);
  }, [activeWorkflow, selectedEdgeId, selectedNodeId, updateActiveWorkflow]);

  const autoLayout = useCallback(() => {
    if (!activeWorkflow) return;
    const nodes = activeWorkflow.nodes || [];
    const adjacency = graphAdjacency(activeWorkflow);
    const flowNodesOnly = nodes.filter((node) => node.type !== 'phase');
    const phaseNodes = nodes.filter((node) => node.type === 'phase');
    const indegree = new Map(flowNodesOnly.map((node) => [node.id, 0]));
    const outgoing = new Map(flowNodesOnly.map((node) => [node.id, []]));
    for (const edge of visibleWorkflowEdges(activeWorkflow)) {
      if (!indegree.has(edge.target) || !outgoing.has(edge.source)) continue;
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
      outgoing.get(edge.source).push(edge.target);
    }
    const queue = flowNodesOnly.filter((node) => node.type === 'start' || (indegree.get(node.id) || 0) === 0);
    const layers = new Map(queue.map((node) => [node.id, node.type === 'start' ? 0 : 1]));
    while (queue.length) {
      const node = queue.shift();
      const layer = layers.get(node.id) || 0;
      for (const nextId of outgoing.get(node.id) || []) {
        if ((layers.get(nextId) ?? -1) < layer + 1) layers.set(nextId, layer + 1);
        const next = nodes.find((item) => item.id === nextId);
        if (next && !queue.includes(next)) queue.push(next);
      }
    }
    const groups = new Map();
    for (const node of flowNodesOnly) {
      const layer = layers.get(node.id) ?? (node.type === 'end' ? 4 : 1);
      if (!groups.has(layer)) groups.set(layer, []);
      groups.get(layer).push(node);
    }
    const positions = new Map();
    for (const node of flowNodesOnly) {
      const layer = layers.get(node.id) ?? (node.type === 'end' ? 4 : 1);
      const group = groups.get(layer) || [];
      const sorted = group.slice().sort((a, b) => {
        if (a.type === 'start') return -1;
        if (b.type === 'start') return 1;
        if (a.type === 'end') return 1;
        if (b.type === 'end') return -1;
        return (a.position?.y || 0) - (b.position?.y || 0);
      });
      const index = sorted.findIndex((item) => item.id === node.id);
      positions.set(node.id, {
        x: 80 + layer * 310,
        y: 150 + index * 138 - Math.min(180, ((group.length - 1) * 138) / 2)
      });
    }
    phaseNodes.forEach((phaseNode, index) => {
      const assigned = flowNodesOnly
        .filter((node) => effectiveNodePhase(node, adjacency) === phaseNode.label)
        .map((node) => positions.get(node.id) || node.position)
        .filter(Boolean);
      if (assigned.length) {
        const minX = Math.min(...assigned.map((position) => position.x));
        const minY = Math.min(...assigned.map((position) => position.y));
        positions.set(phaseNode.id, { x: minX, y: minY - 78 });
        return;
      }
      positions.set(phaseNode.id, {
        x: 390 + index * 310,
        y: 54
      });
    });
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) => {
        const position = positions.get(node.id) || node.position || { x: 0, y: 0 };
        return {
          ...node,
          position
        };
      })
    }));
    setFitTrigger((value) => value + 1);
  }, [activeWorkflow, updateActiveWorkflow]);

  const createWorkflow = useCallback(async () => {
    const created = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '新建工作流', description: '可视化 Claude Code 工作流。' })
    });
    setWorkflows((items) => [created.workflow, ...items]);
    setActiveId(created.workflow.id);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDirty(false);
    setFitTrigger((value) => value + 1);
  }, []);

  const saveWorkflow = useCallback(async () => {
    if (!activeWorkflow) return;
    const result = await api(`/api/workflows/${activeWorkflow.id}`, {
      method: 'PUT',
      body: JSON.stringify(cleanWorkflowGraph(activeWorkflow))
    });
    setWorkflows((items) => items.map((workflow) => workflow.id === activeWorkflow.id ? result.workflow : workflow));
    setActiveId(result.workflow.id);
    setDirty(false);
    addLog('event', `已保存到 .claude/workflows/${result.workflow.commandName}.js\n`);
  }, [activeWorkflow, addLog]);

  const deleteWorkflow = useCallback(async () => {
    if (!activeWorkflow) return;
    await api(`/api/workflows/${activeWorkflow.id}`, { method: 'DELETE' });
    setWorkflows((items) => items.filter((workflow) => workflow.id !== activeWorkflow.id));
    setActiveId((current) => {
      const rest = workflows.filter((workflow) => workflow.id !== activeWorkflow.id);
      return current === activeWorkflow.id ? rest[0]?.id || null : current;
    });
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDirty(false);
  }, [activeWorkflow, workflows]);

  const runWorkflow = useCallback(async () => {
    if (!activeWorkflow || running) return;
    setLogs([]);
    const result = await api(`/api/workflows/${activeWorkflow.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ input: taskInput })
    });
    setRunning(true);
    setRunId(result.run.id);
    addLog('event', `已发送：/${activeWorkflow.commandName || activeWorkflow.id} ${JSON.stringify({ task: taskInput })}\n`);
  }, [activeWorkflow, running, taskInput, addLog]);

  const cancelRun = useCallback(async () => {
    if (!runId) return;
    await api(`/api/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
    setRunning(false);
    addLog('event', '已请求取消运行。\n');
  }, [runId, addLog]);

  const switchWorkflow = useCallback((id) => {
    setActiveId(id);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setInspectorOpen(false);
    setDirty(false);
    setFitTrigger((value) => value + 1);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Ultracode</h1>
          <p title={context?.projectRoot || ''}>{context?.projectRoot || '正在加载项目...'}</p>
        </div>
        <div className="sidebar-actions">
          <button className="primary" onClick={createWorkflow}>新建工作流</button>
          <button onClick={loadAll}>刷新</button>
        </div>
        <div className="workflow-list">
          {workflows.map((workflow) => (
            <button key={workflow.id} className={`workflow-item ${workflow.id === activeWorkflow?.id ? 'active' : ''}`} onClick={() => switchWorkflow(workflow.id)}>
              <strong>{workflow.name}</strong>
              <span>{workflow.description || `/${workflow.commandName || workflow.id}`}</span>
            </button>
          ))}
        </div>
        <div className="status-panel">
          <div><span className={`dot ${context?.claude?.installed ? 'ok' : ''}`} />Claude Code：{context?.claude?.installed ? escapeText(context.claude.version || '已安装') : '不可用'}</div>
          <div>命令来源：{context?.claude?.commandSource || '未知'}</div>
          <div>官方目录：.claude/workflows</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {activeWorkflow ? (
            <div className="topbar-title">
              <strong>{activeWorkflow.name}{dirty ? ' *' : ''}</strong>
              <span>/{activeWorkflow.commandName || activeWorkflow.id}</span>
            </div>
          ) : (
            <div className="topbar-title"><strong>暂无工作流</strong><span>新建一个工作流后开始编排。</span></div>
          )}
          <button className="primary" onClick={saveWorkflow} disabled={!activeWorkflow}>保存</button>
          <button onClick={autoLayout} disabled={!activeWorkflow}>自动布局</button>
          <button onClick={() => setInspectorOpen((value) => !value)} disabled={!activeWorkflow}>{inspectorOpen ? '收起属性' : '属性面板'}</button>
          <button onClick={deleteSelected} disabled={!selectedNodeId && !selectedEdgeId}>删除所选</button>
          <button className="danger" onClick={deleteWorkflow} disabled={!activeWorkflow}>删除工作流</button>
        </header>

        <section className={`workbench ${inspectorOpen ? '' : 'inspector-closed'}`}>
          <div className="canvas-zone react-flow-zone">
            <div className="palette">
              <button onClick={() => addNodeToWorkflow('step')}>调用 agent()</button>
              <button onClick={() => addNodeToWorkflow('parallel')}>列表并行</button>
              <button onClick={() => addNodeToWorkflow('phase')}>阶段标记</button>
              <button onClick={() => addNodeToWorkflow('end')}>返回结果</button>
            </div>
            {notice ? <div className="canvas-notice">{notice}</div> : null}
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
              fitView
              onlyRenderVisibleElements={false}
              zoomOnDoubleClick={false}
              connectOnClick
              connectionRadius={38}
              fitViewOptions={{ padding: 0.18 }}
              proOptions={{ hideAttribution: true }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onEdgesDelete={onEdgesDelete}
              onConnect={onConnect}
              onNodeClick={(_event, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onNodeDoubleClick={onNodeDoubleClick}
              onEdgeClick={(_event, edge) => {
                if (isVirtualEdge(edge)) return;
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
              onSelectionChange={({ nodes, edges }) => {
                const node = nodes[0];
                const edge = edges.find((item) => !isVirtualEdge(item));
                if (node) {
                  setSelectedNodeId(node.id);
                  setSelectedEdgeId(null);
                  return;
                }
                if (edge) {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(edge.id);
                }
              }}
            >
              <Background color="#1b2636" gap={28} />
              <MiniMap pannable zoomable nodeColor={(node) => node.data?.node?.type === 'phase' ? '#2563eb' : nodeAccent(node.data?.node || {})} />
              <Controls showInteractive={false} />
              <AutoFit trigger={`${activeWorkflow?.id || ''}:${fitTrigger}:${flowNodes.length}:${flowEdges.length}`} />
            </ReactFlow>
            <div className={`canvas-help ${issues.length ? 'warn' : ''}`}>
              {issues[0] || '单击选择，双击编辑；React Flow 负责端口、连线、拖拽和缩放；一个节点连到多个 agent 会生成 parallel()。'}
            </div>
          </div>

          {inspectorOpen ? (
            <Inspector
              workflow={activeWorkflow}
              selectedNode={selectedNode}
              onWorkflowChange={updateWorkflowFields}
              onNodeChange={updateNode}
              onClose={() => setInspectorOpen(false)}
            />
          ) : null}
        </section>

        <section className="runner">
          <div className="task-panel">
            <label htmlFor="taskInput">args.task</label>
            <textarea id="taskInput" value={taskInput} onChange={(event) => setTaskInput(event.target.value)} placeholder="输入本次要交给 workflow 的任务内容。" />
            <div className="run-actions">
              <button className="primary" onClick={runWorkflow} disabled={running || !activeWorkflow}>执行</button>
              <button onClick={cancelRun} disabled={!running}>取消</button>
              <button onClick={() => setLogs([])}>清空日志</button>
            </div>
          </div>
          <div className="log-panel">
            <div className="log-head">
              <span>{runId ? `运行 ${runId}` : '尚未执行'}</span>
              <span>{running ? '运行中' : '空闲'}</span>
            </div>
            <pre className="log" ref={logRef}>
              {logs.map((item, index) => <span key={`${item.at}-${index}`} className={item.level}>{item.text}</span>)}
            </pre>
          </div>
        </section>
      </main>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    window.__ultracodeLastError = `${error?.stack || error?.message || error}\n${info?.componentStack || ''}`;
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-error">
          <h1>前端渲染失败</h1>
          <pre>{this.state.error?.stack || this.state.error?.message || String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('app')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
