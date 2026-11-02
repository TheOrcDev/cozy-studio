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
// A copy written this recently may not be in a listing yet, so its absence proves nothing.
const LISTING_GRACE_MS = 10_000;

interface MirroredFile {
  size: number;
  mtimeMs: number;
}

export interface LibraryMirror {
  readonly root: string;
  /** Downloads the file if this instance does not have it yet. Returns whether it exists now. */
  hydrate(filePath: string): Promise<boolean>;
  hydrateAll(filePaths: Iterable<string | null | undefined>): Promise<void>;
  /**
   * Brings a root-relative prefix up to date with object storage: downloads objects this instance
   * lacks or that another instance replaced, and removes files another instance deleted since the
   * last call. Returns how many local files changed.
   */
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
  // The remote copies this instance last downloaded, uploaded or listed, and when.
  const remoteEtags = new Map<string, { etag: string; seenAt: number }>();
  const rememberEtag = (key: string, etag: string | undefined) => {
    if (etag) remoteEtags.set(key, { etag, seenAt: Date.now() });
  };
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
      rememberEtag(key, object.ETag);
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
      const put = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: readFileSync(filePath),
          Metadata: { [MTIME_METADATA]: String(Math.floor(stat.mtimeMs)) },
        }),
      );
      rememberEtag(key, put.ETag);
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
      remoteEtags.delete(key);
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
      const startedAt = Date.now();
      const listed = new Set<string>();
      let token: string | undefined;
      let changed = 0;
      do {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each page needs the previous page's continuation token.
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) {
          if (!object.Key || !filter(object.Key)) continue;
          const key = object.Key;
          listed.add(key);
          knownRemote.add(key);
          missingRemote.delete(key);
          const filePath = pathFor(key);
          const previous = remoteEtags.get(key)?.etag;
          if (previous === undefined) rememberEtag(key, object.ETag);
          const replaced =
            previous !== undefined && object.ETag !== undefined && previous !== object.ETag;
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Downloads stay sequential to bound memory.
          if ((!existsSync(filePath) || replaced) && (await download(key, filePath))) changed += 1;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      for (const [key, { seenAt }] of [...remoteEtags]) {
        if (!key.startsWith(prefix) || listed.has(key) || !filter(key)) continue;
        if (seenAt > startedAt - LISTING_GRACE_MS) continue;
        remoteEtags.delete(key);
        knownRemote.delete(key);
        const filePath = pathFor(key);
        const local = statSync(filePath, { throwIfNoEntry: false });
        const previous = synced.get(filePath);
        // A file changed here and not uploaded yet stays; the next sync uploads it again.
        if (!local || !previous || previous.size !== local.size) continue;
        if (previous.mtimeMs !== local.mtimeMs) continue;
        rmSync(filePath, { force: true });
        synced.delete(filePath);
        removeEmptyParents(path.dirname(filePath), pathFor(prefix));
        changed += 1;
      }
      return changed;
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

function removeEmptyParents(directory: string, stopAt: string) {
  for (
    let current = directory;
    current.startsWith(`${stopAt}${path.sep}`);
    current = path.dirname(current)
  ) {
    try {
      if (readdirSync(current).length > 0) return;
      rmSync(current, { recursive: true, force: true });
    } catch {
      return;
    }
  }
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
