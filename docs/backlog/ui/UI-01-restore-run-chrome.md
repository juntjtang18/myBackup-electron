# UI-01 — Restore source-panel Pause / Stop chrome

**Component:** UI · **Layer:** [B1](../../B1-mybackup-design-restore.md)  
**Priority:** P0 · **Status:** ✅ · **Iteration:** I1  
**Depends:** [RST-01](../restore/RST-01-restore-path-and-pause.md) · **Related:** [UI-02](./UI-02-backup-run-chrome.md)

---

## Summary

When **Restore** is clicked, hide all other source-panel action buttons and show **Pause** + **Stop**. When paused: **Resume** + **Stop**. When the run ends, restore the idle button set.

---

## Problem / discussion

Today Restore becomes static **Restoring...** with no Pause/Stop. User wants a clear mode switch: idle actions vs run controls.

---

## Rationale

1. One obvious control surface while restore is active.
2. Same chrome pattern as backup ([UI-02](./UI-02-backup-run-chrome.md)).
3. Separates UI from RST-01 engine work.

---

## Design

1. Enter `restore-running` mode on start — hide Backup / Restore / Changes / settings for that row; show Pause + Stop.
2. Pause → Pausing… → Resume + Stop.
3. Stop or terminal → idle buttons.
4. Wire to RST-01 pause/stop IPC.

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-UI01-1 | Restore running | Only Pause + Stop visible on that source row |
| AT-UI01-2 | Restore paused | Resume + Stop visible |
| AT-UI01-3 | Restore completed/stopped | Idle buttons restored |

---

## Out of scope

- Path / append rules (RST-01)
- Backup button chrome (UI-02)
