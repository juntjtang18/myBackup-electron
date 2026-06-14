const { classifyMedia, getSourceTargetRoot, planLogicalTarget } = require('./pathPlanner');

function inferMappingMode(source, kind) {
  if (source.organizeMedia && (kind === 'image' || kind === 'video')) {
    return kind === 'video' ? 'media-video' : 'media-image';
  }
  if (source.mergeEnabled) {
    return 'merge';
  }
  return 'direct';
}

function resolveTargetMapping(input) {
  const kind = input.kind || classifyMedia(input.filePath || input.sourceRelativePath || '');
  return {
    logicalPath: planLogicalTarget({
      machineId: input.machineId,
      source: input.source,
      sourceRelativePath: input.sourceRelativePath,
      kind,
      timestamp: input.timestamp
    }),
    sourceTargetRoot: getSourceTargetRoot(input.machineId, input.source),
    kind,
    mappingMode: inferMappingMode(input.source, kind),
    decided: true
  };
}

module.exports = {
  resolveTargetMapping
};
