# Backup Status Checkpointing

**Component:** [B3](./B3-mybackup-design-backup-status.md)

## Goal

Persist a small folder bookmark so Pause / Resume can skip already-walked folders. Not a completeness guarantee on a live tree.

## Bookmark

- `status` — `running` / `paused` / `completed` / `failed` / `stopped`
- `cursor.folder` — unfinished folder (treated as **not started**)
- `copiedBytes` / `copiedFiles` — totals from **finished** folders only

Resume starts that folder from scratch and accumulates onto those totals.

## Pause / Resume / Stop

1. Pause: halt, cleanup temps, write `paused` + cursor  
2. Resume: walk from cursor folder onward  
3. Stop: same halt; clear job + cursor  
4. Complete: `completed`; `cursor: null`

Inserts before the cursor are out of scope for this run (same as inserts into already-finished folders).

## Running writes

`statusCheckpointWriter` coalesces in-memory snapshots so workers do not write status JSON per file.
