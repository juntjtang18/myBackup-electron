# Change Tracking

## Purpose

Change Tracking owns persisted source change data.

Its job is to:

- record file and folder change signals from the watcher
- persist those signals safely
- expose backup-safe change lists to the backup coordinator
- preserve compatibility with the current dirty journal file location and shape

This module is the boundary between:

- watch-time change capture
- backup-time changed-folder scanning
- future UI/debug inspection of recent change events

## Current implementation

The current implementation is still **folder-scan based**.

That means:

- the watcher records file and folder changes
- those changes are collapsed into changed folders
- backup scans those changed folders and processes direct child files

Two data layers exist in the journal:

### `folders`

`folders` is the **backup-safe source of truth**.

It is used by the backup engine to decide which folders need scanning.
This is the part of the journal that the current backup flow depends on.

### `events`

`events` is **not** used by the current backup algorithm.

It exists for:

- UI/debug visibility
- future detailed change tracking
- future evolution toward file-level action lists

Current rule:

- `folders` drives backup behavior
- `events` is auxiliary only

## Current persistence

For compatibility, the journal is still stored at:

```text
watch/<sourceId>.dirty.json
```

under the app-local data root.

### Version behavior

The current module:

- **writes version 2**
- **reads version 1**
- normalizes version 1 into version 2 in memory

### Version 1 compatibility shape

```json
{
  "version": 1,
  "sourceId": "documents-0cf0ec50",
  "lastEventSeq": 128,
  "updatedAt": "2026-06-10T10:02:00.000Z",
  "folders": {
    "a/b": {
      "seq": 115,
      "changedAt": "2026-06-10T10:01:00.000Z"
    }
  }
}
```

### Version 2 stored shape

```json
{
  "version": 2,
  "sourceId": "documents-0cf0ec50",
  "lastEventSeq": 128,
  "updatedAt": "2026-06-10T10:02:00.000Z",
  "folders": {
    "a/b": {
      "seq": 115,
      "changedAt": "2026-06-10T10:01:00.000Z",
      "eventCount": 3
    }
  },
  "events": [
    {
      "seq": 128,
      "at": "2026-06-10T10:02:00.000Z",
      "relPath": "a/b/file.txt",
      "parentRelPath": "a/b",
      "kind": "file",
      "action": "changed"
    }
  ]
}
```

## Public classes

The change tracking module lives under:

```text
src/core/changeTracking/
```

Current public classes:

### `ChangeTracker`

The public API used by:

- `WatchService`
- `BackupCoordinator`
- future IPC/UI integration

This is the module boundary other runtime code should use.

### `ChangeJournal`

The in-memory domain object.

It owns:

- journal normalization
- mutation rules
- sequence advancement
- event append logic
- changed-folder clearing rules
- compatibility projection back to the legacy dirty-state shape

### `ChangeJournalStore`

Persistence only.

It owns:

- reading journal JSON from disk
- normalizing stored version 1 or version 2 data into `ChangeJournal`
- writing journal JSON atomically
- ensuring the journal exists

It does **not** own backup policy or watcher policy.

## Public API

The main public API surface is `ChangeTracker`.

### `recordFileChanged(source, absPath, now = new Date())`

Records a file change.

Current behavior:

1. resolves `absPath` relative to the source root
2. computes the parent folder relative path
3. increments `lastEventSeq`
4. updates the parent folder entry in `folders`
5. appends a file event to `events`

This is the normal path used for watched file changes.

### `recordFolderChanged(source, absPath, now = new Date())`

Records a folder change.

Current behavior:

1. resolves `absPath` relative to the source root
2. increments `lastEventSeq`
3. updates that folder entry in `folders`
4. appends a folder event to `events`

### `getChangeList(source, now = new Date())`

Returns the current backup-facing change list.

Current return shape:

```json
{
  "sourceId": "...",
  "sourcePath": "...",
  "scanSeq": 128,
  "generatedAt": "...",
  "listType": "changed-folders",
  "items": [
    {
      "relativePath": "a/b",
      "kind": "folder",
      "seq": 115,
      "changedAt": "...",
      "eventCount": 3
    }
  ],
  "legacyDirtyState": {
    "version": 1,
    "sourceId": "...",
    "lastEventSeq": 128,
    "updatedAt": "...",
    "folders": {
      "a/b": {
        "seq": 115,
        "changedAt": "..."
      }
    }
  }
}
```

Important:

- `items` is the new structured API
- `legacyDirtyState` exists so the current backup engine can keep using the existing folder scanner

### `clearChangeIfUnchanged(source, relativePath, scanSeq, now = new Date())`

Clears a changed folder only if it has not been updated since the scan snapshot.

Rule:

- if `folder.seq <= scanSeq`, remove it
- if `folder.seq > scanSeq`, keep it

This preserves the current crash-safe incremental behavior.

### `getRecentEvents(source, limit = 100)`

Returns recent journal events for UI/debug/future inspection.

This is not used by the current backup algorithm.

### `clearAfterFullBackup(source, now = new Date())`

Clears change state after a successful full backup.

Current behavior:

- clears `folders`
- clears `events`
- updates `updatedAt`

This resets the journal to a clean baseline state.

## Backup integration rule

`BackupCoordinator` should use:

```text
ChangeTracker.getChangeList()
```

Current backup rule:

- backup reads the change list
- backup uses `legacyDirtyState` to preserve the current folder-scan flow
- backup does not depend on `events`

Important restrictions:

- `BackupCoordinator` should **not** read `events`
- `BackupCoordinator` should treat `folders` as **scan-required hints**
- `folders` remains the backup-safe contract

That keeps the current backup algorithm stable while the change model evolves.

## UI integration rule

Renderer code should never read journal files directly.

UI access rule:

- renderer accesses change data through IPC only
- renderer does not open or parse `watch/<sourceId>.dirty.json`

Reason:

- persistence format should remain a backend concern
- UI should depend on stable APIs, not storage layout

## Future direction

The current API is intentionally shaped for later evolution.

Today:

```json
{
  "listType": "changed-folders"
}
```

Later, `getChangeList()` may return:

```json
{
  "listType": "detailed-changes"
}
```

That future mode can support:

- file-level changes
- delete actions
- more explicit copy/delete planning

For now, none of that is active.

Current contract:

- `listType` is `"changed-folders"`
- backup remains folder-scan based
- `events` is retained for visibility and future growth, not current backup decisions
