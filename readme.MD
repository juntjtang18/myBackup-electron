# MyBackup

Electron shell for a personal backup tool.

## Current State

Step 1 is implemented: the metadata foundation.

The project now defines and tests the stable JSON contract for:

- app config
- machine records
- source records
- hash records
- scan state
- folder checkpoints

The metadata layout under a backup target is:

```text
.mybackup/
  config.json
  machines/
  sources/
  hashes/
  scans/
  tmp/
```

The file metadata already includes a future storage hook:

```json
{
  "content": {
    "type": "plain",
    "path": "Backups/Machines/..."
  }
}
```

Later this can expand to block-deduped storage with:

```json
{
  "content": {
    "type": "blocks",
    "manifest": ".mybackup/dedupe/files/..."
  }
}
```

## Code Areas

- [src/core/ids.js](./src/core/ids.js)
- [src/core/layout.js](./src/core/layout.js)
- [src/core/schema.js](./src/core/schema.js)
- [src/core/jsonStore.js](./src/core/jsonStore.js)
- [src/core/metadataStore.js](./src/core/metadataStore.js)

## Development

```bash
npm install
npm start
npm test
```
