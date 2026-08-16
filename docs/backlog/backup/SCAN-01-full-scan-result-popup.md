# SCAN-01 — Full Scan result in status panel

**Component:** Backup / Full Scan · **Layer:** [B3](../../B3-mybackup-design-backup-status.md)  
**Priority:** P1 · **Status:** ✅ · **Iteration:** I1  
**Related:** [UI-02](../ui/UI-02-backup-run-chrome.md) · [SCAN-02](./SCAN-02-source-count-includes-ignored.md)

---

## Summary

When **Full Scan** / **Full Backup** (`forceNewScan: true`) finishes successfully, show the comparison in the **source↔target status panel** (not a modal):

| Side | Shows |
|---|---|
| **Left — Source** | File count + total size under the registered source |
| **Right — Target** | File count + total size under this source’s backup tree |
| Cross | Missing count; backed-up yes/no (+ copied / errors if useful) |

---

## Problem / discussion

After Full Scan completes, there is no at-a-glance source vs target comparison. A one-shot popup is easy to dismiss and disconnects from the existing left/right layout; the status panel is the natural place.

---

## Design

1. Completed Full Scan returns a `scanResult` on the summary.
2. Renderer binds `scanResult` into the existing status panel: left = source, right = target.
3. Pause / Stop / failed runs do not publish a successful scan result.
4. Backup Changes does not refresh SCAN-01 metrics.

### Metrics (locked)

| Field | Definition |
|---|---|
| Source count / size | Files walked under registered `sourcePath` |
| Target count / size | Files under `target/getSourceTargetRoot(source)` (real folder walk after the run) |
| Missing | Source-relative path with no file at the planned target path |
| Backed up | `missing === 0 && errors === 0` |

Do **not** use persisted `backupSizeBytes` as target size (it currently mirrors source discovered bytes).

---

## Acceptance

| # | Given | Then |
|---|---|---|
| AT-SCAN01-1 | Full Scan completes successfully | Status panel shows source (left) and target (right) counts/sizes, missing, backed-up |
| AT-SCAN01-2 | User continues using the source row | Panel remains the normal status surface (no blocking modal) |

---

## Out of scope

- Modal / popup dialog for scan results  
- Restore completion panel  
- Deep missing-file browser  
- Backup Changes scan-result refresh  
