import {
  StorageDriver,
  LocalStorageConfig,
  StorageOption,
} from '../interfaces';
import { dirname, resolve, sep } from 'path';
import * as fs from 'fs-extra';
import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';

export class LocalDriver implements StorageDriver {
  private readonly config: LocalStorageConfig;

  constructor(config: LocalStorageConfig) {
    this.config = config;
  }

  private _fullPath(filePath: string): string {
    const storageRoot = resolve(this.config.storagePath);
    const fullPath = resolve(storageRoot, filePath);
    if (fullPath !== storageRoot && !fullPath.startsWith(storageRoot + sep)) {
      throw new Error('Invalid file path');
    }
    return fullPath;
  }

  async upload(filePath: string, file: Buffer | Readable): Promise<void> {
    try {
      const fullPath = this._fullPath(filePath);
      if (file instanceof Buffer) {
        await fs.outputFile(fullPath, file);
      } else {
        await fs.mkdir(dirname(fullPath), { recursive: true });
        await pipeline(file, createWriteStream(fullPath));
      }
    } catch (err) {
      throw new Error(`Failed to upload file: ${(err as Error).message}`);
    }
  }

  async uploadStream(
    filePath: string,
    file: Readable,
    options?: { recreateClient?: boolean },
  ): Promise<void> {
    try {
      const fullPath = this._fullPath(filePath);
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await pipeline(file, createWriteStream(fullPath));
    } catch (err) {
      throw new Error(`Failed to upload file: ${(err as Error).message}`);
    }
  }

  async copy(fromFilePath: string, toFilePath: string): Promise<void> {
    try {
      const fromFullPath = this._fullPath(fromFilePath);
      const toFullPath = this._fullPath(toFilePath);

      if (await this.exists(fromFilePath)) {
        await fs.copy(fromFullPath, toFullPath);
      }
    } catch (err) {
      throw new Error(`Failed to copy file: ${(err as Error).message}`);
    }
  }

  async read(
    filePath: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Buffer> {
    try {
      return await readFile(this._fullPath(filePath), {
        signal: options?.abortSignal,
      });
    } catch (err) {
      throw new Error(`Failed to read file: ${(err as Error).message}`);
    }
  }

  async readStream(filePath: string): Promise<Readable> {
    const fullPath = this._fullPath(filePath);
    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`File not found: ${filePath}`);
    }
    return createReadStream(fullPath);
  }

  async readRangeStream(
    filePath: string,
    range: { start: number; end: number },
  ): Promise<Readable> {
    const fullPath = this._fullPath(filePath);
    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`File not found: ${filePath}`);
    }
    return createReadStream(fullPath, {
      start: range.start,
      end: range.end,
    });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      return await fs.pathExists(this._fullPath(filePath));
    } catch (err) {
      throw new Error(
        `Failed to check file existence: ${(err as Error).message}`,
      );
    }
  }

  async getSignedUrl(filePath: string, expireIn: number): Promise<string> {
    throw new Error('Signed URLs are not supported for local storage.');
  }

  getUrl(filePath: string): string {
    return this._fullPath(filePath);
  }

  async delete(filePath: string): Promise<void> {
    try {
      const storageRoot = resolve(this.config.storagePath);
      const fullPath = this._fullPath(filePath);
      if (fullPath === storageRoot) {
        throw new Error('Refusing to delete the storage root');
      }
      await fs.remove(fullPath);
      await this._removeEmptyParents(dirname(fullPath), storageRoot);
    } catch (err) {
      throw new Error(`Failed to delete file: ${(err as Error).message}`);
    }
  }

  private async _removeEmptyParents(
    dir: string,
    storageRoot: string,
  ): Promise<void> {
    while (dir.startsWith(storageRoot + sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }

  getDriver(): typeof fs {
    return fs;
  }

  getDriverName(): string {
    return StorageOption.LOCAL;
  }

  getConfig(): Record<string, any> {
    return this.config;
  }
}
