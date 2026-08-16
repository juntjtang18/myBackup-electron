const path = require('path');
const {
  canReusePausedRestore,
  chooseRestoreDestination,
  getRestoreSourceFolderName
} = require('../src/core/restoreDestination');

describe('chooseRestoreDestination', () => {
  const source = {
    sourceId: 'src-1',
    sourcePath: '/Users/me/gpa',
    includeSourceRoot: true
  };

  test('never defaults to sourcePath when destination is not provided', async () => {
    const pickDirectory = jest.fn(async () => '/tmp/newsource');
    const askAppend = jest.fn(async () => false);

    const choice = await chooseRestoreDestination({
      source,
      input: {},
      pickDirectory,
      askAppend
    });

    expect(pickDirectory).toHaveBeenCalled();
    expect(choice).toEqual({
      destinationRoot: path.resolve('/tmp/newsource'),
      appendFolder: false
    });
  });

  test('canceling the folder picker aborts restore', async () => {
    const choice = await chooseRestoreDestination({
      source,
      input: {},
      pickDirectory: async () => null,
      askAppend: async () => true
    });

    expect(choice).toBeNull();
  });

  test('append on nests into newsource/a at the engine via appendFolder', async () => {
    const choice = await chooseRestoreDestination({
      source,
      input: {},
      pickDirectory: async () => '/tmp/newsource',
      askAppend: async ({ defaultAppend, sourceFolderName }) => {
        expect(defaultAppend).toBe(true);
        expect(sourceFolderName).toBe('gpa');
        return true;
      }
    });

    expect(choice.appendFolder).toBe(true);
    expect(choice.destinationRoot).toBe(path.resolve('/tmp/newsource'));
  });

  test('canceling the append confirm aborts restore', async () => {
    const choice = await chooseRestoreDestination({
      source,
      input: {},
      pickDirectory: async () => '/tmp/newsource',
      askAppend: async () => null
    });

    expect(choice).toBeNull();
  });

  test('explicit destinationRoot skips the picker', async () => {
    const pickDirectory = jest.fn();
    const choice = await chooseRestoreDestination({
      source,
      input: { destinationRoot: '/tmp/given', appendFolder: true },
      pickDirectory
    });

    expect(pickDirectory).not.toHaveBeenCalled();
    expect(choice).toEqual({
      destinationRoot: path.resolve('/tmp/given'),
      appendFolder: true
    });
  });

  test('paused restore reuses the chosen folder and append flag', async () => {
    const pickDirectory = jest.fn();
    const choice = await chooseRestoreDestination({
      source,
      input: {},
      pausedJob: {
        status: 'paused',
        requestedDestinationRoot: '/tmp/newsource',
        destinationRoot: '/tmp/newsource/gpa',
        appendFolder: true
      },
      pickDirectory
    });

    expect(pickDirectory).not.toHaveBeenCalled();
    expect(choice).toEqual({
      destinationRoot: '/tmp/newsource',
      appendFolder: true
    });
  });

  test('canReusePausedRestore is false for a new run', () => {
    expect(canReusePausedRestore(null, {})).toBe(false);
    expect(canReusePausedRestore({ status: 'completed' }, {})).toBe(false);
  });

  test('getRestoreSourceFolderName uses the source folder name', () => {
    expect(getRestoreSourceFolderName(source)).toBe('gpa');
  });
});
