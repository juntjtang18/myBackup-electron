# B0 — Path layout (backup / restore)

**Index:** [A0](./A0-mybackup-design.md)

## Backup (append folder checked)

Registered **target** + **source/a**:

```text
source/a  -->  target  ==>  target/a
```

Implemented via `includeSourceRoot` / “Append source root folder name” in `src/core/pathPlanner.js`.

## Restore (default)

Given registered `target/.` and `source/a`:

```text
target/a  -->  source/a
```

No second append by default. Optional restore-time append (default off) may nest to `source/a/a`. Missing/empty `target/a` → copy nothing.

**Backlog:** [RST-01](./backlog/restore/RST-01-restore-path-and-pause.md)

## Code

- `src/core/pathPlanner.js`
