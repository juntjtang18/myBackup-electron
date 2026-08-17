# CAT-01 — Target catalog

**Layer:** [B5](../../B5-mybackup-design-target-catalog.md) · **Pri:** P1 · **Status:** ✅ · **Iter:** [I3](../../C5-mybackup-iteration3-plan.md)

```text
computerId   = OS computer name (macOS / Windows / Linux, no .local)
locator      = computerId:/path
set          = one tree  target/gpa
```

```mermaid
flowchart LR
  A["A juns-mac-mini:/Users/ziyu/gpa"] -->|backup| T["target/gpa"]
  T -->|Add Target| B["B: locator offline"]
  B -->|Restore ask path| W["wire bobs-mac:/Users/bob/gpa"]
  W --> T
```

| | On target | On this computer |
|---|---|---|
| What | sets + latest backup | local path, watch, pause |
| List / Restore | enough | not needed |
| Backup | + local folder | needed |

```text
same computerId + folder exists  →  online   Backup+Restore
other computerId                 →  offline  Restore only
A ↔ B backup                     →  same tree, keep-newer
history                          →  keep all runs (cap 200)
restore                          →  current tree (no version pick)
```

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-CAT01-1 | Add Target | Read only `catalog.json` |
| AT-CAT01-2 | A: Add Source + Full Backup | Catalog has set + locator + `lastBackup` |
| AT-CAT01-3 | B: Add Target only | Offline. Restore on. Backup off. |
| AT-CAT01-4 | B: Restore, pick folder | Copy `target/gpa`. Wire locator. Online. |
| AT-CAT01-5 | B: Full Backup | History appends. `lastBackup` is B. |
| AT-CAT01-6 | Wipe app data | Same OS `computerId`. No local binding → offline. Restore re-wires. |
