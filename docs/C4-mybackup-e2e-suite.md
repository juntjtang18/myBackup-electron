# C4 — End-to-end copy path (design)

**Index:** [A0](./A0-mybackup-design.md) · **Paths:** [B0](./B0-mybackup-design-path-layout.md) · **Restore:** [B1](./B1-mybackup-design-restore.md) · **Ignore / report:** [C3](./C3-mybackup-iteration2-plan.md) · **Card:** [B4](./B4-mybackup-design-registration.md)

One fixture, one story, in order. This is the user-visible copy path: Full Backup → ignore → changes → keep-newer → restore. It is **not** file versioning (`filename(2)`, block storage). That is later.

Existing tests in `metadataFoundation.test.js` cover pieces. This suite is the **sequential** proof they stay true together.

```text
prepare source
  → Full Backup
  → ignore
  → change tracking
  → Backup Changes
  → keep-newer (backup)
  → restore all
  → restore skip dest-newer
  → restore overwrite dest-older
```

---

## Locked rules the suite asserts

| Rule | Expected |
|---|---|
| Layout | Append on: `source/a` → `target/a` |
| Ignore | Matched paths not copied; counted in Full Backup Total / Ignored |
| Changes | Watch/dirty folder → Backup Changes copies only that set |
| Empty Changes | Completes; no hang (BUG-01) |
| Keep-newer | Source/backup newer → write. Dest missing → write. Dest newer or same age (2s) → skip. No `file (2).txt` |
| Delete | Source delete does **not** delete the target copy |
| Restore dest | Empty `newsource`; append off: contents of `target/a` → `newsource` |
| Restore card | Do not copy `BACKUP.md` or `.mybackup-info.json` |
| Card | Written on each completed backup; history grows |

---

## Fixture

```text
app data     = tmp/app
target       = tmp/target
source/a     = tmp/source/a
newsource    = tmp/newsource          ← restore dest, created empty when needed
```

Register target + source `a` with **append on**. Ignore rules in app-data `.mbignore` (not only a leftover source file).

```text
source/a/
  keep/hello.txt          "hello-v1"
  keep/nested/note.txt    "note"
  skip/ignored.tmp        "tmp-ignore"     ← ignore rule: *.tmp
  skip/junk/inside.txt    "junk"           ← ignore rule: skip/junk/
```

Default OS junk (`.DS_Store`) may appear; it must not be copied. `node_modules` is **not** ignored unless the user says so — do not put one in this fixture.

---

## Story (run in this order)

### 1. Prepare + Full Backup

- Run Full Backup.
- `target/a/keep/hello.txt` and `target/a/keep/nested/note.txt` exist, content and mtime match source.
- `target/a/skip/ignored.tmp` and `target/a/skip/junk/` do **not** exist.
- `scanResult.kind === 'full'`. Source backed up == Target. Ignored ≥ 2. Total == backed up + ignored.
- `target/a/BACKUP.md` and `target/a/.mybackup-info.json` exist. History length 1. Kind Full.

### 2. Ignore still holds after a second Full Backup

- Run Full Backup again with no source edits.
- Ignored paths still absent on the target.
- Unchanged kept files are not recopied as new content (same bytes / skip-unchanged).
- Card history length 2.

### 3. File changes are captured

- Edit `keep/hello.txt` → `"hello-v2"`, set mtime **newer**.
- Add `keep/new.txt` → `"new"`.
- Add `keep/added/dir.txt` → `"dir"`.
- Mark those folders dirty (same path the watcher would).
- Change list / dirty state includes `keep` (and `keep/added` if that is how the journal records it).
- Do **not** run backup yet — this step only proves capture.

### 4. Backup Changes

- Run Backup Changes (not Full).
- `target/a/keep/hello.txt` is `"hello-v2"`.
- `target/a/keep/new.txt` and `target/a/keep/added/dir.txt` exist.
- Ignored paths still absent.
- `scanResult.kind === 'changes'`. Copied count ≥ 3. Completes (not stuck running).
- Card history appends a Changes row.

### 5. Empty Backup Changes

- No further edits. Run Backup Changes.
- Status `completed`. Files copied 0. Does not hang.

### 6. Keep-newer on backup (not versioning)

Same path `keep/hello.txt` on source vs `target/a/keep/hello.txt`.

| Case | Setup | Expected |
|---|---|---|
| Source newer | Source mtime ≫ target, content `"hello-v3"` | Target becomes `"hello-v3"`. No `hello (2).txt` |
| Target newer | Target mtime ≫ source, target content `"target-wins"` | Target stays `"target-wins"`. `skippedNewer` ≥ 1 on Full Backup |
| Same age | mtimes within 2s, different content | Skip. Target unchanged |

Use Full Backup for the target-newer case (that is where skip-newer is reported).

### 7. Source delete is not a target delete

- Delete `source/a/keep/new.txt`.
- Dirty + Backup Changes (or Full Backup).
- `target/a/keep/new.txt` **still exists**.

### 8. Restore — copy all (empty dest)

- Restore append **off** into empty `newsource`.
- `newsource/keep/hello.txt`, `nested/note.txt`, `added/dir.txt` exist.
- Ignored source files are not on the target, so they are not restored.
- `newsource/BACKUP.md` and `newsource/.mybackup-info.json` do **not** exist.
- Restored file count == user files on `target/a` (not card files).

### 9. Restore — skip dest-newer

- In `newsource/keep/hello.txt` write `"dest-newer"` and set mtime ≫ backup file.
- Restore again into the same `newsource`.
- File stays `"dest-newer"`. `skippedRecords` ≥ 1 for that file.

### 10. Restore — overwrite dest-older

- Write `"dest-older"` and set mtime ≪ backup file.
- Restore again.
- File becomes the backup content. `restoredFiles` ≥ 1 for that file.

### 11. Restore append on (short)

- Restore append **on** into empty `tmp/newsource-append`.
- Files land in `tmp/newsource-append/a/…`, not `tmp/newsource-append/keep/…` at the root.

---

## What else (include or park)

### Include in this suite (small, same fixture)

| Extra | Why |
|---|---|
| Nested folder | Already in fixture (`keep/nested`, `keep/added`) |
| mtime preserved on first copy | Restore/backup keep-newer depends on it |
| Card skipped on restore | Easy to get wrong; already in story §8 |
| Empty Changes completes | BUG-01 regression |
| Source delete kept on target | Users expect “backup”, not a mirror |

### Second suite (do not fold into the happy path)

| Extra | Why separate |
|---|---|
| Pause / Resume / Stop (backup + restore) | Timing, cursors; already has AT-RST01-4 and backup pause tests |
| Copy failure listed under Failed | Needs a planted EIO / chmod trap |
| Two sources on one target | Isolation / folder names |
| Append **off** on backup | Card and files sit in the target root |
| Empty / missing `target/a` restore | Already AT-RST01-2 |
| Symlink copied as a link | Platform-specific |
| Watcher live events (not injected dirty) | Flaky in CI |
| UI chrome (four buttons, progress panel) | Renderer tests, not this engine story |
| Unregistered disk restore | Locked: cannot start; not a copy-path test |

### Out of scope (do not test as if they exist)

- `filename(2)` / numbered copies
- Hash-if-size-same versioning
- Volume catalog / scan the portable disk
- Mirror delete
- Block storage

---

## Shape in code

Implemented: [`__tests__/e2eCopyPath.test.js`](../__tests__/e2eCopyPath.test.js) (E2E-01…11). Port target: [`__tests__/e2ePortTarget.test.js`](../__tests__/e2ePortTarget.test.js) (E2E-PORT-01…05).

Helpers only: temp dirs, register target+source, write fixture + mtimes, mark dirty, `backupSource`, `restoreSource`, read tree.

Do **not** add this story into `metadataFoundation.test.js`. That file is already the unit/integration dump.

One `describe`, tests named `E2E-01` … `E2E-11` so a failure points at the step. Shared `beforeAll` fixture, or one test that calls steps in order if later steps need earlier disk state. Prefer **one ordered describe with `beforeAll` disk** and step tests that assert the current tree — Jest runs files in one worker by default if we do not parallelize this file.

---

## Acceptance

The suite is done when a clean `jest __tests__/e2eCopyPath.test.js` proves the table in **Locked rules** on one tree, without touching Pause, UI, or versioning.

---

## Port target (second computer)

Same engine helpers. Two app-data roots, one shared `target`.

```text
A Full Backup → catalog.json
B Add Target  → offline set (no gpa/ walk)
B Restore     → copy tree, skip card, wire computerId:/path
B Full Backup → same target/gpa (even if dest folder is Documents)
wipe B data   → same OS computerId, no binding → offline, Restore re-wires
```

| # | Assert |
|---|---|
| E2E-PORT-01 | Catalog has set + A locator + `lastBackup` |
| E2E-PORT-02 | B sees set offline; no `readdir` of `gpa/` |
| E2E-PORT-03 | Restore to `Documents`; files in; card out; row online; `relativeRoot` stays `gpa` |
| E2E-PORT-04 | B backup writes `target/gpa`, not `target/Documents`; origin stays A |
| E2E-PORT-05 | Wipe B app data → same OS `computerId`; Restore re-wires |
