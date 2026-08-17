# MyBackup — High-level design

MyBackup is an Electron app that backs up registered **source** folders to registered **target** roots (local or external volumes) and can restore those trees into a folder the user chooses.

## Core concepts

| Concept | Meaning |
|---|---|
| Target | Folder the user adds. Self-contained: `catalog.json` + files. [B5](./B5-mybackup-design-target-catalog.md) |
| Source / set | One tree `target/a`. Locator `computerId:/path`. |
| Binding | This install’s local folder for a set. Watch/pause stay here. |
| Append on backup | `source/a` stored under `target/a` |
| App data | This install: opened targets + bindings. **History:** [B4](./B4-mybackup-design-registration.md) owned all definitions here. |

## Completeness on a live tree

A backup run is a **walk**, not a frozen snapshot.

- Files added to a folder **after** that folder was processed in this run are not copied in this run.
- That is true with or without Pause. Pause/Resume does not create a new class of miss.
- Watch / Backup Changes may catch some later inserts **if** the app was watching. That is not guaranteed (app quit, watcher gaps).
- **Only a static folder** can be shown complete in one pass. A changing filesystem cannot.
- Enforcing “everything that exists at end of run is on the target” is **not** the job of copy, Pause, or Resume. A later Full Backup is the completeness pass.

Pause/Resume therefore optimizes **continuing the walk**, not closing the tree.

Detail: [B3](./B3-mybackup-design-backup-status.md).

## Layers

See [B0](./B0-mybackup-design-path-layout.md) … [B5](./B5-mybackup-design-target-catalog.md). [B4](./B4-mybackup-design-registration.md) = as-implemented history. Delivery: [C0](./C0-mybackup-backlog.md) · [CAT-01](./backlog/catalog/CAT-01-target-catalog.md).
