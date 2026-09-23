import * as fs from 'node:fs/promises';
import type { AtomicFileSystemPort } from '@kai/contracts';

export class NodeFileSystem implements AtomicFileSystemPort {
  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async readText(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeText(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, 'utf8');
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await fs.rm(path, { force: true });
  }

  async list(path: string): Promise<string[]> {
    return fs.readdir(path);
  }
}
