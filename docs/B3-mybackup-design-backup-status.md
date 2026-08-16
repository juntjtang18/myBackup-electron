# B3 — Backup status / checkpointing

**Index:** [A0](./A0-mybackup-design.md) · **Detail:** [backup-status-checkpointing.md](./backup-status-checkpointing.md)

How a backup run Pause / Resume / Stop works.

---

## Locked design

**Pause / Resume is not responsible for a changing filesystem.**

A run only sees the tree as it walks. Files added to a folder **after** that folder was processed are missed — with or without Pause. Only a later Full Backup (or Backup Changes, if watch recorded the folder) can pick them up. Completeness is guaranteed only for a **static** tree.

So the cursor “hole” (`a/e` paused, then `a/b/f` added) is the same class of miss as “file added to a folder already finished in this run.” It is **not** a pause/resume defect.

**Keep the folder cursor** for Resume efficiency. Do not rescan from the root just to chase inserts.

| Action | Workers | Bookmark | Next |
|---|---|---|---|
| **Run** | Walk + copy; advance cursor as folders are processed | `status=running` + folder cursor | Pause or Stop |
| **Pause** | Halt; delete unfinished temps | `status=paused` + cursor (unfinished folder) | Resume or Stop |
| **Resume** | Continue walk from cursor (redo that folder; skip folders before it) | Same job | Pause or Stop |
| **Stop** | Same halt as Pause | **Clear** job + cursor | Idle — new run |

```text
Pause  → halt, drop temps, SAVE cursor (folder to redo)
Resume → walk from that folder onward (skip-ahead)
Stop   → same halt, DELETE job/cursor
```

Mid-folder Pause: redo the whole unfinished folder. No copied-file list.

Inserts before the cursor stay for a later Changes / Full Backup — same as inserts into already-finished folders during a run that never paused.

### Unfinished folder = not started

Any folder that did not finish is treated as **not started**. Mid-folder copy does not count in the bookmark. No file list.

```text
cursor = { folder, copiedBytes, copiedFiles }
         unfinished folder     totals from finished folders only
```

Example: `a/b/c` and `a/d/e` done, `a/f` paused halfway → save `folder=a/f` and counts through `a/d/e`. Resume starts `a/f` from scratch and accumulates onto those counts.

UI may show live mid-folder progress. Pause persists the **not-started** baseline for the open folder.

---

## Current code

Folder cursor + skip-ahead on Resume: `walkFoldersFromCursor` / `scanFullSource(resumeFrom)`.

Pause and running checkpoints persist **folder-start baseline** counts (unfinished folder = not started). Live UI still increments per file.

Watch records folder dirties only while the app is running; Full Resume does not consume that journal. That is fine under this lock.

---

## Code

- `src/core/backupCoordinator.js`
- `src/core/engine/fullScanner.js` / `folderWalker.js`
- `src/index.js` — `app:run-backup`, `app:pause-backup`

## Related backlog

| Item | Detail |
|---|---|
| UI-02 | Backup Pause/Stop chrome + Stop abandon — [detail](./backlog/ui/UI-02-backup-run-chrome.md) |
| SCAN-01 | Full Scan result in status panel — [detail](./backlog/backup/SCAN-01-full-scan-result-popup.md) |
| SCAN-02 | Last-run report (Source backed up == Target; Total == Finder) — [detail](./backlog/backup/SCAN-02-source-count-includes-ignored.md) |
| UI-03 | Simplify idle buttons — [detail](./backlog/ui/UI-03-simplify-source-buttons.md) |
| BUG-01 | Backup Changes stuck running — [detail](./backlog/bugs/BUG-01-backup-changes-stuck-running.md) |
