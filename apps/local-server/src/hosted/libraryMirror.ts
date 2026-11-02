import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Hosted Library storage (ADR 0012). Every instance keeps the Library at the same absolute path
// under HOSTED_ROOT, so paths stored in Postgres stay valid everywhere. Files are downloaded from
// object storage when first read and uploaded after they change. Only files this instance has seen
// can be deleted remotely: a file missing locally is merely not downloaded yet.

const EXCLUDED_SEGMENTS = ['/.studio/logs/', '/logs/history/'];
const EXCLUDED_SUFFIXES = ['.tmp', '.partial', '.sqlite', '.sqlite-wal', '.sqlite-shm'];
const MTIME_METADATA = 'cozy-mtime-ms';

interface MirroredFile {
  size: number;
  mtimeMs: number;
}

export interface LibraryMirror {
  readonly root: string;
  /** Downloads the file if this instance does not have it yet. Returns whether it exists now. */
  hydrate(filePath: string): Promise<boolean>;
  hydrateAll(filePaths: Iterable<string | null | undefined>): Promise<void>;
  /** Downloads every object under a root-relative prefix whose key passes the filter. */
  hydratePrefix(prefix: string, filter?: (key: string) => boolean): Promise<number>;
  /** Remote size and mtime without downloading the file. */
  head(filePath: string): Promise<MirroredFile | null>;
  /** Whether the file exists locally or was seen remotely. */
  knownToExist(filePath: string): boolean;
  /** Uploads new or changed files and deletes remote copies of files removed here. */
  sync(): Promise<{ uploaded: number; deleted: number }>;
}

export function createLibraryMirror({
  root,
  bucket,
  client = new S3Client({ forcePathStyle: true }),
}: {
  root: string;
  bucket: string;
  client?: S3Client;
}): LibraryMirror {
  const synced = new Map<string, MirroredFile>();
  const knownRemote = new Set<string>();
  const missingRemote = new Map<string, number>();
  let syncing: Promise<{ uploaded: number; deleted: number }> | null = null;
  let syncAgain = false;

  const keyFor = (filePath: string) => {
    const relative = path.relative(root, path.resolve(filePath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
  };
  const pathFor = (key: string) => path.join(root, ...key.split('/'));
  const isMirrored = (filePath: string) => {
    const normalized = filePath.split(path.sep).join('/');
    return (
      !EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment)) &&
      !EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    );
  };

  const download = async (key: string, filePath: string) => {
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await object.Body?.transformToByteArray();
      if (!bytes) return false;
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, bytes);
      // Thumbnail cache keys include the source mtime, so keep it stable across instances.
      const mtimeMs = Number(object.Metadata?.[MTIME_METADATA]);
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        utimesSync(filePath, new Date(), new Date(mtimeMs));
      }
      const stat = statSync(filePath);
      synced.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
      knownRemote.add(key);
      return true;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') {
        missingRemote.set(key, Date.now());
        return false;
      }
      throw error;
    }
  };

  const hydrate = async (filePath: string) => {
    if (existsSync(filePath)) return true;
    const key = keyFor(filePath);
    if (!key || !isMirrored(filePath)) return false;
    const missingSince = missingRemote.get(key);
    if (missingSince && Date.now() - missingSince < 5_000) return false;
    return download(key, filePath);
  };

  const walk = (directory: string, files: string[]) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath, files);
      else if (entry.isFile() && isMirrored(entryPath)) files.push(entryPath);
    }
  };

  const syncOnce = async () => {
    const files: string[] = [];
    walk(root, files);
    const present = new Set(files);
    let uploaded = 0;
    let deleted = 0;
    for (const filePath of files) {
      const stat = statSync(filePath, { throwIfNoEntry: false });
      const key = keyFor(filePath);
      if (!stat || !key) continue;
      const previous = synced.get(filePath);
      if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: readFileSync(filePath),
          Metadata: { [MTIME_METADATA]: String(Math.floor(stat.mtimeMs)) },
        }),
      );
      synced.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
      knownRemote.add(key);
      missingRemote.delete(key);
      uploaded += 1;
    }
    for (const filePath of [...synced.keys()]) {
      if (present.has(filePath)) continue;
      const key = keyFor(filePath);
      synced.delete(filePath);
      if (!key) continue;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      knownRemote.delete(key);
      deleted += 1;
    }
    return { uploaded, deleted };
  };

  return {
    root,
    hydrate,
    async hydrateAll(filePaths) {
      const unique = [...new Set([...filePaths].filter((item): item is string => !!item))];
      await Promise.all(unique.map((filePath) => hydrate(filePath)));
    },
    async hydratePrefix(prefix, filter = () => true) {
      let token: string | undefined;
      let count = 0;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) {
          if (!object.Key || !filter(object.Key)) continue;
          knownRemote.add(object.Key);
          const filePath = pathFor(object.Key);
          if (!existsSync(filePath) && (await download(object.Key, filePath))) count += 1;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return count;
    },
    async head(filePath) {
      const key = keyFor(filePath);
      if (!key) return null;
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        knownRemote.add(key);
        const mtimeMs = Number(object.Metadata?.[MTIME_METADATA]);
        return {
          size: Number(object.ContentLength ?? 0),
          mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
        };
      } catch {
        return null;
      }
    },
    knownToExist(filePath) {
      if (existsSync(filePath)) return true;
      const key = keyFor(filePath);
      return key ? knownRemote.has(key) || !missingRemote.has(key) : false;
    },
    sync() {
      if (syncing) {
        syncAgain = true;
        return syncing;
      }
      syncing = (async () => {
        let total = { uploaded: 0, deleted: 0 };
        do {
          syncAgain = false;
          const result = await syncOnce();
          total = {
            uploaded: total.uploaded + result.uploaded,
            deleted: total.deleted + result.deleted,
          };
        } while (syncAgain);
        return total;
      })().finally(() => {
        syncing = null;
      });
      return syncing;
    },
  };
}

/** Removes leftovers of an earlier instance so nothing stale is uploaded as new. */
export function resetHostedRoot(root: string) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
}

export function thumbnailCacheKey(
  relativePath: string,
  size: number,
  mtimeMs: number,
  maxEdge: number,
) {
  return createHash('sha1')
    .update(`${relativePath}:${size}:${Math.floor(mtimeMs)}:${maxEdge}`)
    .digest('hex')
    .slice(0, 12);
}
