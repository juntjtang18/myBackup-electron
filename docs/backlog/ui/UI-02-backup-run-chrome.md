# UI-02 — Backup source-panel Pause / Stop chrome

**Component:** UI · **Layer:** [B3](../../B3-mybackup-design-backup-status.md)  
**Priority:** P0 · **Status:** ✅ · **Iteration:** I1  
**Related:** [UI-01](./UI-01-restore-run-chrome.md) · [UI-03](./UI-03-simplify-source-buttons.md)

---

## Summary

Same as UI-01 for every backup start action:

- **Full Backup** / **Full Scan** (`run-full-scan-button`, `forceNewScan: true`)
- **Backup Changes**
- **Resume**

Hide source-panel buttons; show **Pause** + **Stop** (paused: **Resume** + **Stop**).

---

## Problem / discussion

Backup already morphs the primary button to Pause/Resume, but other actions stay visible and there is no dedicated Stop.

---

## Design

1. Shared source-panel run mode `{ mode: 'backup' | 'restore', status }`.
2. Pause / Resume / Stop follow the bookmark model in [B3](../../B3-mybackup-design-backup-status.md): Pause saves the bookmark; Stop clears it. Worker halt is the same for both.
3. Pause → existing `app:pause-backup`.
4. Stop → `app:stop-backup` (abandon).
5. Terminal → idle buttons.

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-UI02-1 | Full Backup / Full Scan / Backup Changes running | Only Pause + Stop on that row |
| AT-UI02-2 | Backup paused | Resume + Stop |
| AT-UI02-3 | Run ended | Idle buttons restored |

---

## Out of scope

- Restore chrome (UI-01)
- Full Scan result panel ([SCAN-01](../backup/SCAN-01-full-scan-result-popup.md))
