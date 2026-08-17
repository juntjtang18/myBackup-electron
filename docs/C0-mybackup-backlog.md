# MyBackup — Backlog

**Single source of truth** for IDs, status, and priority.  
**Detail specs:** [backlog/](./backlog/README.md) · **Roadmap:** [C1](./C1-mybackup-iteration-plan.md)

| Doc | Purpose |
|---|---|
| [A0-mybackup-design.md](./A0-mybackup-design.md) | Documentation index |
| [A1-mybackup-highlevel-design.md](./A1-mybackup-highlevel-design.md) | Whole-system design |
| [backlog/](./backlog/README.md) | Detail specs per item |
| [C1-mybackup-iteration-plan.md](./C1-mybackup-iteration-plan.md) | Roadmap + iteration links |

**Status:** ✅ done · 🔶 partial · *(empty)* open · ❌ failed · 📋 planned · ⏸️ unscheduled  
**Priority:** `P0` block · `P1` core · `P2` polish · `P3` later · `—` shipped/N/A

---

## Status rollup

| Status | Count | Notes |
|---|---|---|
| ✅ done | 9 | RST-01, RST-02, UI-01, UI-02, SCAN-01, BUG-01, UI-03, SCAN-02, CAT-01 |
| 📋 planned | 0 | — |
| ⏸️ unscheduled | 0 | — |

**Current focus:** I3 ✅ CAT-01 shipped · [B5](./B5-mybackup-design-target-catalog.md)

---

## Catalog / portability

**Design:** [B5](./B5-mybackup-design-target-catalog.md) · [B4](./B4-mybackup-design-registration.md)

| ID | Summary | Pri | Iter | Status | Detail |
|---|---|---|---|---|---|
| CAT-01 | Target catalog: Add Target lists sets; Restore wires `computerId:/path` | P1 | I3 | ✅ | [detail](./backlog/catalog/CAT-01-target-catalog.md) |

---

## Restore

**Design:** [B0](./B0-mybackup-design-path-layout.md) · [B1](./B1-mybackup-design-restore.md) · [B5](./B5-mybackup-design-target-catalog.md) · **History:** [B4](./B4-mybackup-design-registration.md) · **Code:** `src/core/restoreService.js`, `pathPlanner.js`

| ID | Summary | Pri | Iter | Status | Detail |
|---|---|---|---|---|---|
| RST-01 | Restore `target/a` → `source/a` (no second append); engine pause/resume/stop; empty → copy nothing | P0 | I1 | ✅ | [detail](./backlog/restore/RST-01-restore-path-and-pause.md) |
| RST-02 | Click Restore asks for `newsource`; append on → `newsource/a` | P1 | — | ✅ | [detail](./backlog/restore/RST-02-restore-asks-destination.md) |

---

## UI (source panel)

**Design:** [B1](./B1-mybackup-design-restore.md) · [B3](./B3-mybackup-design-backup-status.md) · **Code:** `src/renderer.js`

| ID | Summary | Pri | Iter | Status | Detail |
|---|---|---|---|---|---|
| UI-01 | Restore click → hide source buttons; show Pause + Stop | P0 | I1 | ✅ | [detail](./backlog/ui/UI-01-restore-run-chrome.md) |
| UI-02 | Full Backup / Full Scan / Backup Changes → Pause + Stop chrome | P0 | I1 | ✅ | [detail](./backlog/ui/UI-02-backup-run-chrome.md) |
| UI-03 | Idle: Changes, Backup Changes, Full Backup, Restore (no dropdown) | P1 | I2 | ✅ | [detail](./backlog/ui/UI-03-simplify-source-buttons.md) |

---

## Backup / Full Scan

**Design:** [B3](./B3-mybackup-design-backup-status.md)

| ID | Summary | Pri | Iter | Status | Detail |
|---|---|---|---|---|---|
| SCAN-01 | Full Scan result in status panel (source left / target right) | P1 | I1 | ✅ | [detail](./backlog/backup/SCAN-01-full-scan-result-popup.md) |
| SCAN-02 | Last-run report: Source backed up == Target; Total == Finder | P1 | I2 | ✅ | [detail](./backlog/backup/SCAN-02-source-count-includes-ignored.md) |

---

## Bugs

| ID | Summary | Pri | Iter | Status | Detail |
|---|---|---|---|---|---|
| BUG-01 | Backup Changes can stick in running chrome | P0 | I2 | ✅ | [detail](./backlog/bugs/BUG-01-backup-changes-stuck-running.md) |
