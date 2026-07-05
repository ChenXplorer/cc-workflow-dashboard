const { EventEmitter } = require('events');
const { createId } = require('./ids');
const { ClaudeRunner } = require('./claude-runner');

class WorkflowEngine extends EventEmitter {
  constructor(options) {
    super();
    this.projectRoot = options.projectRoot;
    this.appRoot = options.appRoot;
    this.runner = new ClaudeRunner(options);
    this.activeRuns = new Map();
    this.runs = [];
    this.runner.on('chunk', (event) => {
      this.emit('workflow.output', {
        ...event,
        at: new Date().toISOString()
      });
    });
  }

  async readRuns() {
    return this.runs.slice(0, 50);
  }

  async execute(workflow, taskInput = '') {
    const run = {
      id: createId('run'),
      workflowId: workflow.id,
      workflowName: workflow.name,
      commandName: workflow.commandName,
      status: 'running',
      taskInput,
      startedAt: new Date().toISOString(),
      completedAt: null,
      nodes: (workflow.nodes || []).map((node) => ({
        id: node.id,
        label: node.label,
        type: node.type,
        status: node.type === 'start' ? 'completed' : 'pending',
        output: ''
      })),
      output: '',
      error: null
    };

    this.runs.unshift(run);
    this.activeRuns.set(run.id, { run, cancelled: false });
    this.emit('workflow.runStarted', run);

    this.executeBackground(workflow, taskInput, run).catch((error) => {
      run.status = 'failed';
      run.error = error.message;
      run.completedAt = new Date().toISOString();
      this.emit('workflow.runFailed', run);
      this.activeRuns.delete(run.id);
    });

    return run;
  }

  async executeBackground(workflow, taskInput, run) {
    const scriptNode = run.nodes.find((node) => node.type !== 'start' && node.type !== 'end');
    if (scriptNode) {
      scriptNode.status = 'running';
      this.emit('workflow.nodeStarted', {
        runId: run.id,
        workflowId: workflow.id,
        nodeId: scriptNode.id,
        node: scriptNode
      });
    }

    const output = await this.runner.runSavedWorkflow({
      runId: run.id,
      workflow,
      input: taskInput
    });

    if (scriptNode) {
      scriptNode.status = 'completed';
      scriptNode.output = output;
      this.emit('workflow.nodeCompleted', {
        runId: run.id,
        workflowId: workflow.id,
        nodeId: scriptNode.id,
        output
      });
    }
    for (const node of run.nodes) {
      if (node.type === 'end') {
        node.status = 'completed';
        node.output = output;
      }
    }

    run.status = 'completed';
    run.output = output;
    run.completedAt = new Date().toISOString();
    this.emit('workflow.runCompleted', run);
    this.activeRuns.delete(run.id);
  }

  cancel(runId) {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.cancelled = true;
    this.runner.stopRun(runId);
    return true;
  }
}

module.exports = {
  WorkflowEngine
};
