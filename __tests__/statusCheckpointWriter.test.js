const { createStatusCheckpointWriter } = require('../src/core/statusCheckpointWriter');

describe('statusCheckpointWriter', () => {
  test('coalesces multiple dirty marks into a single write for a burst', async () => {
    const snapshots = [];
    let state = { copiedBytes: 0 };
    const writer = createStatusCheckpointWriter({
      buildSnapshot: () => ({ ...state }),
      persistSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      }
    });

    state = { copiedBytes: 1 };
    writer.markDirty();
    state = { copiedBytes: 2 };
    writer.markDirty();
    state = { copiedBytes: 3 };
    writer.markDirty();

    await writer.flushPending();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ copiedBytes: 3 });
  });

  test('flushes again when state changes during an in-flight write', async () => {
    const snapshots = [];
    let state = { copiedBytes: 0 };
    let releaseFirstWrite;
    const firstWriteDone = new Promise((resolve) => {
      releaseFirstWrite = resolve;
    });

    const writer = createStatusCheckpointWriter({
      buildSnapshot: () => ({ ...state }),
      persistSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 1) {
          await firstWriteDone;
        }
      }
    });

    state = { copiedBytes: 1 };
    writer.markDirty();
    await Promise.resolve();
    state = { copiedBytes: 2 };
    writer.markDirty();
    releaseFirstWrite();

    await writer.flushPending();

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({ copiedBytes: 1 });
    expect(snapshots[1]).toEqual({ copiedBytes: 2 });
  });

  test('close flushes pending writes and ignores later dirty marks', async () => {
    const snapshots = [];
    let state = { copiedBytes: 0 };
    const writer = createStatusCheckpointWriter({
      buildSnapshot: () => ({ ...state }),
      persistSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      }
    });

    state = { copiedBytes: 4 };
    writer.markDirty();
    await writer.close();

    state = { copiedBytes: 5 };
    writer.markDirty();
    await writer.flushPending();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ copiedBytes: 4 });
  });

  test('persist errors are reported and do not reject the flush loop', async () => {
    const errors = [];
    const writer = createStatusCheckpointWriter({
      buildSnapshot: () => ({ copiedBytes: 1 }),
      persistSnapshot: async () => {
        const error = new Error("ENOENT: no such file or directory, lstat 'status.json'");
        error.code = 'ENOENT';
        throw error;
      },
      onError: (error) => {
        errors.push(error);
      }
    });

    writer.markDirty();
    await writer.flushPending();

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('ENOENT');
  });
});
