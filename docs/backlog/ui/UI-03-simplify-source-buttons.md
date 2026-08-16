# UI-03 — Simplify source-panel buttons

**Component:** UI · **Layer:** [B3](../../B3-mybackup-design-backup-status.md)  
**Priority:** P1 · **Status:** ✅ · **Iteration:** I2  
**Related:** [UI-01](./UI-01-restore-run-chrome.md) · [UI-02](./UI-02-backup-run-chrome.md)

---

## Summary

Idle source row shows four peer **icon** buttons (no Full Backup chevron menu):

**Changes** · **Backup Changes** · **Full Backup** · **Restore**

Click **Backup Changes**, **Full Backup**, or **Restore** → hide those four; show **Pause** + **Stop** only. Icon-button style does not change.

---

## Problem / discussion

Full Backup is buried in a split-button dropdown next to Backup Changes. That menu clips, and the idle set is harder to scan than four equal actions.

---

## Design

1. Idle: always show Changes, Backup Changes, Full Backup, Restore as separate icon buttons.
2. First-time / needs-rescan sources still show all four; Backup Changes may stay disabled until a baseline exists (do not hide Full Backup behind a menu).
3. Run mode (backup or restore): only Pause + Stop. Paused: Resume + Stop. Terminal: idle four again.
4. Keep existing icon-button chrome (labels under icons). No text-only buttons. No dropdown.

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-UI03-1 | Source idle | Changes, Backup Changes, Full Backup, Restore visible; no chevron / dropdown |
| AT-UI03-2 | Click Backup Changes, Full Backup, or Restore | Only Pause + Stop on that row |
| AT-UI03-3 | Run ended | Idle four restored |

---

## Out of scope

- Changing icon artwork  
- Settings / Exclude / Delete chrome  
- [BUG-01](../bugs/BUG-01-backup-changes-stuck-running.md) (stuck running)  
