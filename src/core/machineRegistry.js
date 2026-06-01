const os = require('os');
const {
  loadAppConfig,
  loadMachine,
  saveAppConfig,
  saveMachine
} = require('./metadataStore');
const {
  createAppConfig,
  createMachineRecord,
  validateAppConfig,
  validateMachineRecord
} = require('./schema');

async function ensureMachine(targetRoot, input = {}) {
  const existingConfig = await loadAppConfig(targetRoot);

  if (existingConfig) {
    validateAppConfig(existingConfig);
    const existingMachine = await loadMachine(targetRoot, existingConfig.machineId);
    if (existingMachine) {
      return existingMachine;
    }
  }

  const now = input.now || new Date();
  const machine = createMachineRecord({
    machineId: input.machineId,
    displayName: input.displayName || os.hostname(),
    hostname: input.hostname || os.hostname(),
    platform: input.platform || os.platform(),
    seed: input.seed
  }, now);

  const config = createAppConfig({
    machineId: machine.machineId,
    createdAt: existingConfig ? existingConfig.createdAt : undefined
  }, now);

  await saveMachine(targetRoot, machine);
  await saveAppConfig(targetRoot, config);
  return machine;
}

async function updateMachine(targetRoot, record, now = new Date()) {
  const current = await loadMachine(targetRoot, record.machineId);
  const merged = createMachineRecord({
    ...current,
    ...record,
    createdAt: current ? current.createdAt : undefined,
    updatedAt: now.toISOString()
  }, now);

  validateMachineRecord(merged);
  await saveMachine(targetRoot, merged);
  return merged;
}

module.exports = {
  ensureMachine,
  updateMachine
};
