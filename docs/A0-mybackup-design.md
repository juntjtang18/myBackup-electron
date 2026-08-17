# MyBackup — Documentation

Entry point for MyBackup design and delivery docs.

---

## Index scheme

```text
A*  Overall          system scope, north star, architecture
B*  Layer/component  path layout · restore · change tracking · backup status · registration
C*  Lower level      backlog · iterations · deep dives
```

| Prefix | Doc | Content |
|---|---|---|
| **A0** | [A0-mybackup-design.md](./A0-mybackup-design.md) | This index |
| **A1** | [A1-mybackup-highlevel-design.md](./A1-mybackup-highlevel-design.md) | Whole-system high-level design (incl. live-tree completeness) |

---

## B — Layer / component design

| ID | Layer | Doc |
|---|---|---|
| **B0** | Path layout | [B0-mybackup-design-path-layout.md](./B0-mybackup-design-path-layout.md) |
| **B1** | Restore | [B1-mybackup-design-restore.md](./B1-mybackup-design-restore.md) |
| **B2** | Change tracking | [B2-mybackup-design-change-tracking.md](./B2-mybackup-design-change-tracking.md) |
| **B3** | Backup status / checkpointing | [B3-mybackup-design-backup-status.md](./B3-mybackup-design-backup-status.md) |
| **B4** | Registration (as implemented / **history**) | [B4-mybackup-design-registration.md](./B4-mybackup-design-registration.md) |
| **B5** | Target catalog (I3 ✅) | [B5-mybackup-design-target-catalog.md](./B5-mybackup-design-target-catalog.md) |

---

## C — Lower level

### Backlog & iterations

| ID | Doc | Content |
|---|---|---|
| **C0** | [C0-mybackup-backlog.md](./C0-mybackup-backlog.md) | Backlog index (IDs, status, priority) |
| | [backlog/README.md](./backlog/README.md) | Backlog detail index |
| | [backlog/catalog/](./backlog/catalog/) | Target catalog / portable sources |
| | [backlog/restore/](./backlog/restore/) | Restore engine / path |
| | [backlog/ui/](./backlog/ui/) | Source-panel run chrome |
| | [backlog/backup/](./backlog/backup/) | Full scan / backup UX |
| | [backlog/bugs/](./backlog/bugs/) | Bugs |
| **C1** | [C1-mybackup-iteration-plan.md](./C1-mybackup-iteration-plan.md) | Roadmap index |
| **C2** | [C2-mybackup-iteration1-plan.md](./C2-mybackup-iteration1-plan.md) | I1 plan + implementation |
| **C3** | [C3-mybackup-iteration2-plan.md](./C3-mybackup-iteration2-plan.md) | I2 plan + implementation |
| **C5** | [C5-mybackup-iteration3-plan.md](./C5-mybackup-iteration3-plan.md) | I3 ✅ — CAT-01 |

### Reference & prior notes

| Doc | Content |
|---|---|
| [B4](./B4-mybackup-design-registration.md) | History: definitions in this Mac `data/` |
| [restore-source-progress.md](./restore-source-progress.md) | Historical restore progress UI design |
| [change-tracking.md](./change-tracking.md) | Change-tracking detail |
| [backup-status-checkpointing.md](./backup-status-checkpointing.md) | Backup status / checkpoint detail |
