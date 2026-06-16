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
- UI display of changed folders and approximate change counts

## Current implementation

The current implementation is still **folder-scan based**.

That means:

- the watcher records file and folder changes
- those changes are collapsed into changed folders
- backup scans those changed folders and processes direct child files

### `folders`

`folders` is the **backup-safe source of truth**.

It is used by the backup engine to decide which folders need scanning.
This is the part of the journal that the current backup flow depends on.

Each folder entry stores:

- `seq`
- `changedAt`
- `eventCount`

`eventCount` is a lightweight approximation of how many change signals have
been observed for that folder since it was last cleared. It is suitable for UI
display, but it is not a durable file-level event log.

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
  }
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
5. increments that folder's `eventCount`

This is the normal path used for watched file changes.

### `recordFolderChanged(source, absPath, now = new Date())`

Records a folder change.

Current behavior:

1. resolves `absPath` relative to the source root
2. increments `lastEventSeq`
3. updates that folder entry in `folders`
4. increments that folder's `eventCount`

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

Compatibility method.

The simplified journal no longer persists per-event history, so this currently
returns an empty list.

### `clearAfterFullBackup(source, now = new Date())`

Clears change state after a successful full backup.

Current behavior:

- clears `folders`
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
- backup does not depend on per-event history

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
- renderer shows changed folders and approximate `eventCount` values only

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
- persisted change tracking is folder-based only
