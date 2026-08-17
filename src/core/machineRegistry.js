const os = require('os');
const { ensureBackupSchema, loadBackupMachine, saveBackupMachine } = require('./backupSchema');
const {
  createMachineRecord,
  validateMachineRecord
} = require('./schema');
const { readOsComputerName } = require('./ids');

async function ensureMachine(appDataRoot, input = {}) {
  const now = input.now || new Date();
  const hostname = input.hostname || readOsComputerName();
  const schema = await ensureBackupSchema(appDataRoot, {
    machineId: input.machineId,
    displayName: input.displayName || hostname,
    hostname,
    platform: input.platform || os.platform(),
    seed: input.seed
  }, now);
  return schema.machine;
}

async function updateMachine(appDataRoot, record, now = new Date()) {
  const current = await loadBackupMachine(appDataRoot);
  const merged = createMachineRecord({
    ...current,
    ...record,
    createdAt: current ? current.createdAt : undefined,
    updatedAt: now.toISOString()
  }, now);

  validateMachineRecord(merged);
  return saveBackupMachine(appDataRoot, merged, now);
}

module.exports = {
  ensureMachine,
  updateMachine
};
