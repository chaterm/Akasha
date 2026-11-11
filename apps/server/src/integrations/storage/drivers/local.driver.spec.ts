import { join, resolve, sep } from 'path';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { LocalDriver } from './local.driver';

type FullPath = (filePath: string) => string;

describe('LocalDriver._fullPath', () => {
  const ROOT = resolve('/data/storage');
  const driver = new LocalDriver({ storagePath: ROOT });
  const fullPath = ((driver as any)._fullPath as FullPath).bind(driver);

  describe('legitimate inputs (behavior preserved)', () => {
    it.each([
      ['workspace-id/avatars/uuid.png', `${ROOT}${sep}workspace-id${sep}avatars${sep}uuid.png`],
      ['workspace-id/files/uuid/file.pdf', `${ROOT}${sep}workspace-id${sep}files${sep}uuid${sep}file.pdf`],
      ['a/b/c/d/e.bin', `${ROOT}${sep}a${sep}b${sep}c${sep}d${sep}e.bin`],
      ['', ROOT],
      ['.', ROOT],
      ['./x/y.png', `${ROOT}${sep}x${sep}y.png`],
      ['a//b', `${ROOT}${sep}a${sep}b`],
      ['a/b/../c', `${ROOT}${sep}a${sep}c`],
    ])('resolves %j to %j', (input, expected) => {
      expect(fullPath(input)).toBe(expected);
    });
  });

  describe('traversal rejected', () => {
    it.each([
      '../etc/passwd',
      '../../../etc/passwd',
      'workspace/../../../etc/passwd',
      '..',
      '../..',
      'a/../../..',
    ])('throws for %j', (input) => {
      expect(() => fullPath(input)).toThrow('Invalid file path');
    });
  });

  describe('absolute path rejected', () => {
    it.each([
      '/etc/passwd',
      '/root/.ssh/id_rsa',
      sep + 'absolute',
    ])('throws for %j', (input) => {
      expect(() => fullPath(input)).toThrow('Invalid file path');
    });
  });

  describe('prefix-confusion rejected', () => {
    it('rejects a sibling directory whose name starts with the storage root', () => {
      const siblingDriver = new LocalDriver({ storagePath: '/data/storage' });
      const siblingFullPath = ((siblingDriver as any)._fullPath as FullPath).bind(siblingDriver);
      // Attempt to reach /data/storage-evil/secret by traversal:
      // resolve('/data/storage', '../storage-evil/secret') === '/data/storage-evil/secret'
      // Without the `+ sep` guard, a startsWith check would match.
      expect(() => siblingFullPath('../storage-evil/secret')).toThrow('Invalid file path');
    });
  });

  describe('storage root itself', () => {
    it('accepts the root when input resolves to it', () => {
      expect(fullPath('')).toBe(ROOT);
      expect(fullPath('.')).toBe(ROOT);
      expect(fullPath('a/..')).toBe(ROOT);
    });
  });
});

describe('LocalDriver.delete', () => {
  let root: string;
  let driver: LocalDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'akasha-local-driver-'));
    driver = new LocalDriver({ storagePath: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes parent directories left empty, stopping at the root', async () => {
    await driver.upload('ws/files/a/file.pdf', Buffer.from('x'));

    await driver.delete('ws/files/a/file.pdf');

    expect(existsSync(join(root, 'ws'))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('keeps parent directories that still have content', async () => {
    await driver.upload('ws/files/a/file.pdf', Buffer.from('x'));
    await driver.upload('ws/files/b/other.pdf', Buffer.from('y'));

    await driver.delete('ws/files/a/file.pdf');

    expect(existsSync(join(root, 'ws', 'files', 'a'))).toBe(false);
    expect(existsSync(join(root, 'ws', 'files', 'b', 'other.pdf'))).toBe(true);
  });

  it('succeeds when the file is already gone', async () => {
    await expect(driver.delete('ws/missing.pdf')).resolves.toBeUndefined();
  });

  it.each(['', '.', 'a/..'])(
    'refuses to delete the storage root for %j',
    async (input) => {
      await driver.upload('keep.txt', Buffer.from('x'));

      await expect(driver.delete(input)).rejects.toThrow(
        'Refusing to delete the storage root',
      );
      expect(existsSync(join(root, 'keep.txt'))).toBe(true);
    },
  );
});
