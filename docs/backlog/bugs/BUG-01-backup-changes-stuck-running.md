# BUG-01 — Backup Changes stuck in running state

**Component:** Backup / UI · **Layer:** [B3](../../B3-mybackup-design-backup-status.md)  
**Priority:** P0 · **Status:** ✅ · **Iteration:** I2  
**Related:** [UI-02](../ui/UI-02-backup-run-chrome.md) · [UI-03](../ui/UI-03-simplify-source-buttons.md)

---

## Summary

Clicking **Backup Changes** can leave the source row stuck in the running chrome (Pause + Stop, copying arrow / live size circle) even after the run should have finished — or as if it never finished.

---

## Problem / discussion

Observed after I1 last-progress work: idle → Backup Changes → UI stays in run mode. Possible causes (confirm in code, do not assume one):

- Optimistic `status: 'running'` never replaced by a terminal payload.
- Empty incremental (no dirty folders) does not emit `backup-completed`.
- Kept last-progress / `isLiveProgressStatus` treats the row as still live.
- `runBackup` completion path does not restore idle chrome.

---

## Design

1. Reproduce: Backup Changes on a source with and without pending changes.
2. Engine must always reach a terminal status (`completed` / `paused` / `stopped` / `failed`), including zero-change incrementals.
3. Renderer must leave run mode on that terminal status and show idle buttons (UI-03 four, until UI-03 ships: current idle set).
4. Last-progress panel may still open from the size circle after complete; that is not “running.”

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-BUG01-1 | Backup Changes with pending changes completes | Idle buttons return; not stuck on Pause + Stop |
| AT-BUG01-2 | Backup Changes with no pending changes | Run ends (completed); idle buttons return |
| AT-BUG01-3 | Size circle after that run | Last progress opens; chrome stays idle |

---

## Out of scope

- Button layout ([UI-03](../ui/UI-03-simplify-source-buttons.md))  
- SCAN-02 inventory rules  
