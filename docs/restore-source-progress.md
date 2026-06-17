# Source Restore Execution + UI Progress Design

## Problem

`Restore` previously returned `restoredFiles: 0` for valid sources and had no live UI
progress state.

## Root Cause

Restore source lookup read schema from `targetRoot` (backup destination path) instead of
the app data root that owns source registration metadata.

## Design

Restore now runs as a threaded file-copy pipeline with live progress events.

### 1) Metadata lookup

- `restoreSource` resolves source registration from `appDataRoot` (`data/` schema).
- Falls back to `targetRoot` only for compatibility in direct tests.

### 2) Task model

- Build restore tasks by walking the stored source logical tree under the selected target.
- Effective restore root is `selectedDestination/<backup-source-folder-name>`.
- Each task contains:
  - `relativePath`
  - `logicalPath`
  - `totalBytes`

### 3) Worker execution

- Use configurable worker count (`workerPools.copy`) with per-worker loops.
- Workers copy files via `restorePlainFile`.
- Progress is counted only on fully restored files (`copiedBytes += fileSize` on completion).

### 4) Progress payload contract

Main process forwards restore progress on the existing `app:backup-progress` channel with:

- `progress.mode = "restore"`
- `progress.destinationRoot`
- `progress.totalBytes`, `progress.copiedBytes`
- file worker snapshots (`pool: "file"`) and queue snapshot
- events:
  - `restore-started`
  - `task-started`
  - `file-progress`
  - `restore-completed`

### 5) Renderer behavior

When `progress.mode === "restore"`:

- source card arrow uses restore direction (left -> right) via mirrored arrow class
- right-side label/path temporarily becomes `Destination` + selected destination root
- size circle shows **remaining bytes** (`totalBytes - copiedBytes`) and counts down to `0`
- clicking size circle still toggles progress panel
- restore button shows `Restoring...` and backup button is disabled for that source

### 6) State safety

- Restore and backup are mutually exclusive per source key.
- Restore terminal events clear in-memory progress UI state.
- Restore terminal status does not overwrite backup pause/resume status fields.
