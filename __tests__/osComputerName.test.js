describe('readOsComputerName', () => {
  const originalPlatform = process.platform;
  const originalComputerName = process.env.COMPUTERNAME;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalComputerName === undefined) {
      delete process.env.COMPUTERNAME;
    } else {
      process.env.COMPUTERNAME = originalComputerName;
    }
    jest.resetModules();
    jest.dontMock('child_process');
    jest.dontMock('fs');
    jest.dontMock('os');
  });

  function loadWithMocks({
    platform,
    execMap = {},
    files = {},
    hostname = 'fallback-host.local',
    computerName
  }) {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: platform });
    if (computerName === undefined) {
      delete process.env.COMPUTERNAME;
    } else {
      process.env.COMPUTERNAME = computerName;
    }
    jest.doMock('child_process', () => ({
      execFileSync: (command, args) => {
        const key = `${command} ${(args || []).join(' ')}`.trim();
        if (Object.prototype.hasOwnProperty.call(execMap, key)) {
          const value = execMap[key];
          if (value instanceof Error) {
            throw value;
          }
          return value;
        }
        throw new Error(`ENOENT: ${key}`);
      }
    }));
    jest.doMock('fs', () => ({
      readFileSync: (filePath) => {
        if (Object.prototype.hasOwnProperty.call(files, filePath)) {
          return files[filePath];
        }
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
    }));
    jest.doMock('os', () => ({
      hostname: () => hostname
    }));
    return require('../src/core/osComputerName');
  }

  test('macOS prefers scutil ComputerName', () => {
    const { readOsComputerName } = loadWithMocks({
      platform: 'darwin',
      execMap: {
        'scutil --get ComputerName': 'Jun\'s Mac mini\n',
        'scutil --get LocalHostName': 'Juns-Mac-mini'
      }
    });
    expect(readOsComputerName()).toBe('Jun\'s Mac mini');
  });

  test('macOS falls back to LocalHostName, then hostname without .local', () => {
    const missing = new Error('not found');
    const { readOsComputerName } = loadWithMocks({
      platform: 'darwin',
      hostname: 'Juns-Mac-mini.local',
      execMap: {
        'scutil --get ComputerName': missing,
        'scutil --get LocalHostName': missing
      }
    });
    expect(readOsComputerName()).toBe('Juns-Mac-mini');
  });

  test('Windows 10/11 uses COMPUTERNAME', () => {
    const { readOsComputerName } = loadWithMocks({
      platform: 'win32',
      computerName: 'DESKTOP-ABC123',
      hostname: 'ignored'
    });
    expect(readOsComputerName()).toBe('DESKTOP-ABC123');
  });

  test('Windows falls back to hostname command', () => {
    const { readOsComputerName } = loadWithMocks({
      platform: 'win32',
      execMap: {
        hostname: 'WIN11-OFFICE'
      }
    });
    expect(readOsComputerName()).toBe('WIN11-OFFICE');
  });

  test('Linux prefers pretty hostname, then /etc/hostname', () => {
    const { readOsComputerName } = loadWithMocks({
      platform: 'linux',
      execMap: {
        'hostnamectl --pretty': '"Studio Box"\n'
      }
    });
    expect(readOsComputerName()).toBe('Studio Box');
  });

  test('Linux falls back to /etc/hostname', () => {
    const missing = new Error('not found');
    const { readOsComputerName } = loadWithMocks({
      platform: 'linux',
      files: {
        '/etc/hostname': 'studio-box\n'
      },
      execMap: {
        'hostnamectl --pretty': missing,
        'hostname -s': missing,
        hostname: missing
      }
    });
    expect(readOsComputerName()).toBe('studio-box');
  });
});
