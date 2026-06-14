const { getSourceTargetRoot, planLogicalTarget } = require('./pathPlanner');

function resolveTargetMapping(input) {
  return {
    logicalPath: planLogicalTarget({
      machineId: input.machineId,
      source: input.source,
      sourceRelativePath: input.sourceRelativePath
    }),
    sourceTargetRoot: getSourceTargetRoot(input.machineId, input.source),
    kind: 'file',
    mappingMode: 'direct',
    decided: true
  };
}

module.exports = {
  resolveTargetMapping
};
