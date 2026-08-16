# B1 — Restore

**Index:** [A0](./A0-mybackup-design.md) · **Prior note:** [restore-source-progress.md](./restore-source-progress.md)

Layer that copies files from the backup tree under a target into a local destination (typically registered `sourcePath`).

Pause / Resume use the same **bookmark** model as backup ([B3](./B3-mybackup-design-backup-status.md)): folder cursor + completed work; Pause saves it; Stop (already implemented for restore) clears it. Restore stores its bookmark in the restore job file, not `backupJob`.

## Active delivery

| Item | Detail |
|---|---|
| RST-01 | Path + engine pause/resume/stop — [detail](./backlog/restore/RST-01-restore-path-and-pause.md) |
| UI-01 | Restore panel Pause/Stop chrome — [detail](./backlog/ui/UI-01-restore-run-chrome.md) |

## Code

- `src/core/restoreService.js`
- `src/index.js` — `app:restore-source`
- `src/renderer.js`
