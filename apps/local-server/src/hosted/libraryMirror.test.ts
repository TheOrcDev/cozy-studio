import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLibraryMirror } from './libraryMirror';

function fakeBucket() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let version = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? '';
        return {
          Contents: [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object]) => ({ Key: key, ETag: object.etag, Size: object.body.length })),
          IsTruncated: false,
        };
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return {
          ETag: object.etag,
          Metadata: {},
          Body: { transformToByteArray: async () => object.body },
        };
      }
      if (command instanceof PutObjectCommand) {
        const etag = `"${(version += 1)}"`;
        objects.set(command.input.Key!, { body: command.input.Body as Uint8Array, etag });
        return { ETag: etag };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      throw new Error('Unexpected command');
    },
  };
  return { objects, client: client as unknown as S3Client };
}

const roots: string[] = [];
function instanceRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'cozy-mirror-'));
  roots.push(root);
  return root;
}

function write(root: string, key: string, content: string) {
  const filePath = path.join(root, ...key.split('/'));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hosted Library mirror', () => {
  it('follows style packs another instance installs, updates and removes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { objects, client } = fakeBucket();
    const rootA = instanceRoot();
    const rootB = instanceRoot();
    const a = createLibraryMirror({ root: rootA, bucket: 'test', client });
    const b = createLibraryMirror({ root: rootB, bucket: 'test', client });
    const runtime = path.join(rootB, 'Extensions', 'cozy.pack-1', 'runtime.json');

    write(rootA, 'Extensions/cozy.pack-1/extension.json', '{"id":"cozy.pack-1"}');
    write(rootA, 'Extensions/cozy.pack-1/runtime.json', '{"v":1}');
    expect((await a.sync()).uploaded).toBe(2);
    expect(await b.hydratePrefix('Extensions/')).toBe(2);
    expect(readFileSync(runtime, 'utf8')).toBe('{"v":1}');
    expect(await b.hydratePrefix('Extensions/')).toBe(0);

    write(rootA, 'Extensions/cozy.pack-1/runtime.json', '{"v":2,"more":true}');
    expect((await a.sync()).uploaded).toBe(1);
    expect(await b.hydratePrefix('Extensions/')).toBe(1);
    expect(readFileSync(runtime, 'utf8')).toBe('{"v":2,"more":true}');

    // B installs a pack it has not uploaded yet; A removes the first one.
    write(rootB, 'Extensions/cozy.pack-2/extension.json', '{"id":"cozy.pack-2"}');
    rmSync(path.join(rootA, 'Extensions', 'cozy.pack-1'), { recursive: true });
    expect((await a.sync()).deleted).toBe(2);
    expect([...objects.keys()]).toEqual([]);
    // A removal this recent may be a listing that has not caught up yet.
    expect(await b.hydratePrefix('Extensions/')).toBe(0);
    vi.setSystemTime(Date.now() + 60_000);
    expect(await b.hydratePrefix('Extensions/')).toBe(2);
    expect(existsSync(path.join(rootB, 'Extensions', 'cozy.pack-1'))).toBe(false);
    expect(existsSync(path.join(rootB, 'Extensions', 'cozy.pack-2', 'extension.json'))).toBe(true);
  });
});
