# RST-02 — Restore asks where to restore

**Component:** Restore · **Layers:** [B1](../../B1-mybackup-design-restore.md), [B0](../../B0-mybackup-design-path-layout.md)  
**Priority:** P1 · **Status:** ✅ · **Iteration:** —  
**Depends:** [RST-01](./RST-01-restore-path-and-pause.md) · **Blocks:** —

---

## Summary

Click Restore always asks for a destination folder (`newsource`). Do not write into the registered `sourcePath` unless the user picks it.

```text
Append off:  target/a  -->  newsource
Append on:   target/a  -->  newsource/a
```

Resume of a paused restore keeps the folder already chosen.

---

## Design

1. New restore → folder picker. `sourcePath` is only the dialog default, not the destination.
2. Confirm with “Append source folder name” (default = the source’s `includeSourceRoot`).
3. Engine: `appendFolder` already nests via `resolveDestinationRoot` ([RST-01](./RST-01-restore-path-and-pause.md) AT-RST01-3).
4. Paused job → reuse `requestedDestinationRoot` + `appendFolder`. No second picker.

**Code:** `restoreDestination.js`, `index.js` `app:restore-source`, `restoreService.js`

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-RST02-1 | Click Restore | Folder picker runs. No silent write to `sourcePath`. |
| AT-RST02-2 | User picks `newsource`, append off | Files from `target/a` land in `newsource/…` |
| AT-RST02-3 | User picks `newsource`, append on | Files land in `newsource/a/…` |
| AT-RST02-4 | Cancel picker or confirm | Restore does not start |
| AT-RST02-5 | Resume paused restore | Same destination; no picker |
