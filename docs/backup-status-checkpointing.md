# Backup Status Checkpointing

## Goal

Persist backup progress safely for pause/resume and crash recovery without turning
`data/status/*.json` into a write bottleneck during high-throughput small-file runs.

## Design

The backup coordinator owns the runtime progress state. File workers never write
status JSON directly.

### Runtime State (authoritative in-memory)

- `copiedBytes`: accumulated bytes for fully copied files only
- `cursor`: current folder checkpoint (`relativePath`, `folderHash`, run metadata)
- `status`: `running` / `paused` / `completed`
- `scanSeq`: current change-tracking sequence

### Coalescing Writer

`createStatusCheckpointWriter` provides one write lane for running checkpoints:

- `markDirty()`: signal that runtime state changed
- `flushPending()`: wait until all queued/coalesced writes are persisted
- `close()`: flush then stop accepting new dirty signals

Behavior:

- Multiple `markDirty()` calls in one burst are coalesced into one persisted write
  containing the latest snapshot.
- If state changes while a write is in flight, one follow-up write persists the
  latest snapshot.
- At most one JSON write is in flight at a time.

## Event Flow

1. Backup starts: source `backupStatus` enters `running`.
2. Folder transition: coordinator updates in-memory cursor, calls `markDirty()`.
3. File completed: coordinator updates in-memory `copiedBytes`, calls `markDirty()`.
4. Pause requested:
   - stop queues/workers
   - `flushPending()` running checkpoint writes
   - remove unfinished temp files
   - persist terminal `paused` state with final `copiedBytes` and cursor
5. Resume:
   - read persisted status JSON
   - initialize in-memory progress from JSON
   - continue traversal/copy from persisted cursor
6. Completion:
   - `flushPending()`
   - persist terminal `completed` state

## Copy-Byte Semantics

- Only fully copied files contribute to `copiedBytes`.
- Partial in-flight file chunks are not persisted.
- On resume, incomplete files restart from source and are not double-counted.

## Crash Window

The design intentionally allows a small window where recent in-memory completed
bytes may not yet be on disk if the process crashes between coalesced flushes.
This trades minimal potential byte lag for much lower JSON write contention.

## Legacy Cutoff

- Removed per-file awaited status JSON writes from worker completion path.
- Running status persistence now goes through the coalescing writer only.
- Terminal states (`paused`, `completed`) still use explicit awaited writes.
