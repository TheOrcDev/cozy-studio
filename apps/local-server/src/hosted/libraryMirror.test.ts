import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
        const { Prefix: prefix = '', Delimiter: delimiter } = command.input;
        const folders = new Set<string>();
        const contents = [];
        for (const [key, object] of objects) {
          if (!key.startsWith(prefix)) continue;
          const cut = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
          if (cut >= 0) folders.add(key.slice(0, cut + 1));
          else contents.push({ Key: key, ETag: object.etag, Size: object.body.length });
        }
        return {
          Contents: contents,
          CommonPrefixes: [...folders].map((folder) => ({ Prefix: folder })),
          IsTruncated: false,
        };
      }
      if (command instanceof HeadObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound' });
        return { ETag: object.etag, ContentLength: object.body.length, Metadata: {} };
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
    const refresh = () => b.hydrateFolders('Extensions/', 'extension.json');
    const pack = path.join(rootB, 'Extensions', 'cozy.pack-1');
    const runtime = path.join(pack, 'runtime.json');

    write(rootA, 'Extensions/.default-pack-offered', '{}');
    write(rootA, 'Extensions/cozy.pack-1/extension.json', '{"version":"1"}');
    write(rootA, 'Extensions/cozy.pack-1/runtime.json', '{"v":1}');
    write(rootA, 'Extensions/cozy.pack-1/cards/SP-1.webp', 'card');
    expect((await a.sync()).uploaded).toBe(4);
    // B takes the marker, the manifest and the folder layout; other files wait until read.
    expect(await refresh()).toBe(2);
    expect(readFileSync(path.join(pack, 'extension.json'), 'utf8')).toBe('{"version":"1"}');
    expect(existsSync(path.join(rootB, 'Extensions', '.default-pack-offered'))).toBe(true);
    expect(existsSync(path.join(pack, 'cards'))).toBe(true);
    expect(existsSync(path.join(pack, 'cards', 'SP-1.webp'))).toBe(false);
    expect(existsSync(runtime)).toBe(false);
    expect(await b.hydrate(runtime)).toBe(true);
    expect(await refresh()).toBe(0);

    // A new version replaces the manifest; B drops what it had read of the old one.
    write(rootA, 'Extensions/cozy.pack-1/extension.json', '{"version":"2.0"}');
    write(rootA, 'Extensions/cozy.pack-1/runtime.json', '{"v":2,"more":true}');
    expect((await a.sync()).uploaded).toBe(2);
    expect(await refresh()).toBe(1);
    expect(readFileSync(path.join(pack, 'extension.json'), 'utf8')).toBe('{"version":"2.0"}');
    expect(existsSync(runtime)).toBe(false);
    expect(await b.hydrate(runtime)).toBe(true);
    expect(readFileSync(runtime, 'utf8')).toBe('{"v":2,"more":true}');

    // B installs a pack it has not uploaded yet; A removes the first one, files it never read too.
    write(rootB, 'Extensions/cozy.pack-2/extension.json', '{"version":"1"}');
    rmSync(path.join(rootA, 'Extensions', 'cozy.pack-1'), { recursive: true });
    expect(await a.removePrefix('Extensions/cozy.pack-1/')).toBe(3);
    expect((await a.sync()).deleted).toBe(0);
    expect([...objects.keys()]).toEqual(['Extensions/.default-pack-offered']);
    // A removal this recent may be a listing that has not caught up yet.
    expect(await refresh()).toBe(0);
    vi.setSystemTime(Date.now() + 60_000);
    expect(await refresh()).toBe(2);
    expect(existsSync(pack)).toBe(false);
    expect(existsSync(path.join(rootB, 'Extensions', 'cozy.pack-2', 'extension.json'))).toBe(true);
  });

  it('drops uploaded images past the local budget but keeps them in object storage', async () => {
    const { objects, client } = fakeBucket();
    const root = instanceRoot();
    const mirror = createLibraryMirror({ root, bucket: 'test', client, localBudgetBytes: 10 });
    const older = path.join(root, 'Library', 'older.png');
    const newer = path.join(root, 'Library', 'newer.png');
    const packThumbnail = path.join(root, 'Extensions', 'cozy.pack-1', 'thumbnails', 'SP-1.webp');
    const notes = path.join(root, 'Library', 'notes.json');

    write(root, 'Library/older.png', 'older-0000');
    utimesSync(older, new Date(1_000), new Date(1_000));
    write(root, 'Extensions/cozy.pack-1/thumbnails/SP-1.webp', 'pack-thumb');
    utimesSync(packThumbnail, new Date(2_000), new Date(2_000));
    write(root, 'Library/newer.png', 'newer-0000');
    write(root, 'Library/notes.json', '{"note":"stays"}');

    expect(await mirror.sync()).toEqual({ uploaded: 4, deleted: 0 });
    // The least recently used images go, style pack thumbnails included; the newest and non-images stay.
    expect(existsSync(older)).toBe(false);
    expect(existsSync(packThumbnail)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(notes)).toBe(true);
    expect(mirror.knownToExist(older)).toBe(true);

    // A dropped copy is not a deletion: the next sync leaves the remote copy alone.
    expect(await mirror.sync()).toEqual({ uploaded: 0, deleted: 0 });
    expect(objects.has('Library/older.png')).toBe(true);

    expect(await mirror.hydrate(older)).toBe(true);
    expect(readFileSync(older, 'utf8')).toBe('older-0000');
    expect(await mirror.hydrate(packThumbnail)).toBe(true);
  });

  it('uploads an edited image before dropping its local copy', async () => {
    const { client } = fakeBucket();
    const root = instanceRoot();
    const mirror = createLibraryMirror({ root, bucket: 'test', client, localBudgetBytes: 0 });
    const image = path.join(root, 'Library', 'draft.png');

    write(root, 'Library/draft.png', 'first');
    await mirror.sync();
    expect(existsSync(image)).toBe(false);

    await mirror.hydrate(image);
    write(root, 'Library/draft.png', 'second-edit');
    // Uploaded by this sync, so only then is it safe to drop.
    expect((await mirror.sync()).uploaded).toBe(1);
    expect(existsSync(image)).toBe(false);
    expect(await mirror.hydrate(image)).toBe(true);
    expect(readFileSync(image, 'utf8')).toBe('second-edit');
  });
});
