const {
  blankOfficialWorkflow,
  readOfficialWorkflows,
  removeOfficialWorkflow,
  writeOfficialWorkflow
} = require('./official-workflows');

class WorkflowStore {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.workflows = [];
    this.loaded = false;
  }

  async load() {
    this.workflows = await readOfficialWorkflows(this.projectRoot);
    this.loaded = true;
    return this.workflows;
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
  }

  async list({ reload = false } = {}) {
    if (reload) await this.load();
    else await this.ensureLoaded();
    return this.workflows.map((workflow) => ({ ...workflow }));
  }

  async get(id) {
    await this.ensureLoaded();
    return this.workflows.find((workflow) => workflow.id === id || workflow.commandName === id) || null;
  }

  async save(input) {
    await this.ensureLoaded();
    const existingIndex = this.workflows.findIndex((workflow) => (
      workflow.id === input.id ||
      workflow.commandName === input.commandName ||
      workflow.file === input.file
    ));
    const existing = existingIndex >= 0 ? this.workflows[existingIndex] : null;
    const saved = await writeOfficialWorkflow(this.projectRoot, {
      ...existing,
      ...input
    }, existing?.file);

    if (existingIndex >= 0) this.workflows[existingIndex] = saved;
    else this.workflows.push(saved);
    return saved;
  }

  async create(input = {}) {
    return this.save({
      ...blankOfficialWorkflow(input),
      ...input
    });
  }

  async delete(id) {
    await this.ensureLoaded();
    const index = this.workflows.findIndex((workflow) => workflow.id === id || workflow.commandName === id);
    if (index === -1) return false;
    const [workflow] = this.workflows.splice(index, 1);
    await removeOfficialWorkflow(workflow.file);
    return true;
  }
}

module.exports = {
  WorkflowStore
};
