# SCAN-02 — Last-run report (Source backed up == Target; Total == Finder)

**Component:** Backup / Full Scan · **Layer:** [B3](../../B3-mybackup-design-backup-status.md)  
**Priority:** P1 · **Status:** ✅ · **Iteration:** I2  
**Related:** [SCAN-01](./SCAN-01-full-scan-result-popup.md)

---

## Summary

After Full Backup / Full Scan, the last-run panel proves the registered source is fully backed up. Finder alone cannot (ignored files make source look bigger than target). The report is the decoder.

```text
Finder source  =  Source backed up  +  Failed  +  Skipped-newer (source bytes)  +  Ignored
Target column  =  Source backed up
```

Clean run: **Source backed up == Target** (safety) and **Total == Finder** (honesty).

Ignore still means **do not copy**. Ignored files count in Total / Ignored, not in Source backed up.

---

## Problem / discussion

Today `scanResult.sourceFileCount` / `sourceSizeBytes` come from files the walker **enqueues** (`sourceFilesEnqueued` / `discoveredSourceBytes`). Ignore rules drop those paths before enqueue, so the left-side source number is “files we considered for backup,” not “files on disk.”

That diverges from Finder / Explorer. After a Full Backup the size circle looks like the source is smaller than the real folder.

Skip-if-target-newer and copy failures are also silent: a 512 B older source vs a 620 B newer target must not be folded into the matching columns (that would make 512 ≠ 620 look like a failed backup).

---

## Design

| Row | Meaning | Copy? |
|---|---|---|
| **Source backed up / Target** | Eligible files in sync (copied this run or already same). Columns must match. | yes / already there |
| **Failed** | Eligible, copy errored. In Finder, not on target. Path + error + source bytes. | no |
| **Skipped (target newer)** | Eligible, did not overwrite. List source size vs target size. Omit section if empty. | no |
| **Ignored** | Ignore list (file or folder, e.g. `node_modules/`). In Finder, not copied. | no |
| **Total** | Sum of source-side buckets. Must match Finder/Explorer. | — |

```text
Source backed up  ==  Target
Total             ==  Source backed up + Failed + Skipped-newer (source bytes) + Ignored
                  ==  Finder
```

Skip-newer stays out of the matching columns. Total uses **source** bytes (512, not 620).

Panel (size circle, not a modal), after Full Backup / Full Scan:

```text
Source backed up          Target
11434 files               11434 files
3423474344 bytes          3423474344 bytes

Failed
2 files · 512 bytes

Ignored
3453 files · 123450 bytes

Total
14989 files · 3423598306 bytes
```

**Also locked**

1. Walk `sourcePath` without ignore → Total / Finder. Apply ignore only to copy / enqueue.
2. Ignore file or folder is OK; do not copy; still count in Total / Ignored.
3. Symlinks (macOS/Linux/Unix): copy the **link**; count as one in-sync file unless ignored.
4. Headline numbers are **inventories**, not “bytes copied this run.”
5. Persist buckets + `failed[]` + `skippedNewer[]` on `scanResult`.
6. Backup Changes: no full-tree Finder walk; keep `kind: 'changes'` change-set counts.

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-SCAN02-1 | Source has ignored files and a Full Backup / Full Scan completes | Ignored in Total / Ignored; not copied; not in Source backed up |
| AT-SCAN02-2 | Source file older/smaller than existing target | Not copied; listed under Skipped (target newer) with source vs target sizes; omitted from Source backed up / Target |
| AT-SCAN02-3 | A copy fails | Listed under Failed with path + error + source bytes; run can complete |
| AT-SCAN02-4 | Clean Full Backup (no fail, no skip-newer) | Source backed up == Target; Total == Source backed up + Ignored == Finder |

---

## Out of scope

- Changing what ignore excludes from **copy**
- Changing Finder’s own rules (app bundles as one item, offline placeholders)
- Restore completion panel
- Full-tree walk on every Backup Changes
