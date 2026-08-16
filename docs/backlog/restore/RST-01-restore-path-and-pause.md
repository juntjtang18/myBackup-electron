# RST-01 — Restore path + engine pause/resume/stop

**Component:** Restore · **Layers:** [B0](../../B0-mybackup-design-path-layout.md), [B1](../../B1-mybackup-design-restore.md)  
**Priority:** P0 · **Status:** ✅ · **Iteration:** I1  
**Depends:** — · **Blocks:** [UI-01](../ui/UI-01-restore-run-chrome.md) (chrome wires to this engine)

---

## Summary

Fix restore destination semantics and add cooperative pause/resume/stop so restore works when a local `source/a` is registered against an existing target (same Mac or another).

Given registered **`target/.`** and **`source/a`**:

- Backup with append checked: `source/a` → `target` → **`target/a`**
- Restore (default): **`target/a` → `source/a`** (no second append)
- Missing/empty `target/a` → **copy nothing** + clear message
- Optional restore “Append folder to source path” (default **off**) → `source/a/a` only when checked
- Engine Pause / Resume / Stop (mirror backup `shouldPause` / `pauseRequested`)
- After **completed** restore: clear dirty journal + needsRescan/full

Source-panel chrome is [UI-01](../ui/UI-01-restore-run-chrome.md).

---

## Problem / discussion

Current restore **walks** `target/a` correctly when layout matches, but **always nests** destination → often `source/a/a`. Restore already can copy a backup folder; the bug is default nesting + missing pause/stop + weak empty messaging. No volume catalog / original-source identity required.

---

## Rationale

1. Backup append creates `target/a` — keep that.
2. Registered source path already ends in `a` — do not append again by default.
3. Backup append and restore append are independent.
4. Empty `target/a` must not look like a hang.
5. Long restores need the same pause model as backup.

---

## Design

```text
Backup (append on):   source/a --> target ==> target/a
Restore (default):    target/a --> source/a ==> source/a
Restore (append on):  target/a --> source/a ==> source/a/a
Missing/empty target/a --> copy nothing
```

1. `restoreService.js` — destination as-is unless `appendFolder`; walk via `getSourceTargetRoot`.
2. IPC — default destination `sourcePath`.
3. `activeRestores` + `shouldPause`; persist cursor; Stop clears job.
4. Completed → clear `watch/<sourceId>.dirty.json`, needsRescan/full.

**Code:** `restoreService.js`, `pathPlanner.js`, `index.js`, `renderer.js`

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-RST01-1 | Append backup produced `target/a`; restore into `source/a` | Files at `source/a/...` not `source/a/a/...` |
| AT-RST01-2 | `target/a` missing or empty | `restoredFiles: 0` + clear empty/missing message |
| AT-RST01-3 | Restore append option on | Files under `source/a/a/...` |
| AT-RST01-4 | Pause mid-restore | Status paused; Resume continues; Stop abandons |

---

## Open questions

- In-flight file pause boundary vs file-boundary only (v1).

## Out of scope

- Volume catalog / Mac A machineId adopt
- Changing backup append semantics
- Volume hash index rebuild
