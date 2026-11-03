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
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Hosted Storage Mirror (ADR 0013). Every instance keeps the Studio Data Folder and Output Folder
// at the same absolute paths under HOSTED_ROOT, so paths stored in Postgres stay valid everywhere.
// Files are downloaded from object storage when first read and uploaded after they change. Only
// files this instance has seen can be deleted remotely: a file missing locally is merely not
// downloaded yet.
// An instance's disk is small and fixed, while the bucket is not, so once local images pass a budget
// the least recently used ones that are already uploaded are dropped and downloaded again on demand.

const EXCLUDED_SEGMENTS = ['/.studio/logs/', '/logs/history/'];
const EXCLUDED_SUFFIXES = ['.tmp', '.partial', '.sqlite', '.sqlite-wal', '.sqlite-shm'];
const MTIME_METADATA = 'cozy-mtime-ms';
// A copy written this recently may not be in a listing yet, so its absence proves nothing.
const LISTING_GRACE_MS = 10_000;
// Only images are dropped: every read of one hydrates it first. Studio state stays.
const EVICTABLE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const PINNED_SEGMENTS = ['/.studio/'];
const DEFAULT_LOCAL_BUDGET_BYTES = 256 * 1024 * 1024;
const TRANSFER_CONCURRENCY = 8;

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
   * Brings the folders directly under a root-relative prefix up to date with object storage, one
   * manifest file per folder. Downloads new or replaced manifests and the files beside the folders,
   * creates each folder's subfolders, and removes folders another instance deleted. A folder's other
   * files download when first read; when its manifest changes, local copies of them are dropped so
   * the next read gets the new ones. Returns how many folders and files changed.
   */
  hydrateFolders(prefix: string, manifestName: string): Promise<number>;
  /** Deletes every remote object under a root-relative prefix, including ones never downloaded. */
  removePrefix(prefix: string): Promise<number>;
  /** Remote size and mtime without downloading the file. */
  head(filePath: string): Promise<MirroredFile | null>;
  /** Whether the file exists locally or was seen remotely. */
  knownToExist(filePath: string): boolean;
  /**
   * Moves or deletes the remote copy of a file this instance does not hold, on the next sync.
   * Catalog archive, restore and purge call these, which cannot wait for object storage.
   */
  moveRemote(from: string, to: string): void;
  removeRemote(filePath: string): void;
  /** Uploads new or changed files and deletes remote copies of files removed here. */
  sync(): Promise<{ uploaded: number; deleted: number }>;
}

export function createLibraryMirror({
  root,
  bucket,
  client = new S3Client({ forcePathStyle: true }),
  localBudgetBytes = DEFAULT_LOCAL_BUDGET_BYTES,
}: {
  root: string;
  bucket: string;
  client?: S3Client;
  /** Local bytes of images to keep before uploaded ones are dropped. */
  localBudgetBytes?: number;
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
  // Remote moves and deletes in the order the catalog asked for them; a null target deletes.
  const pendingRemote: { from: string; to: string | null }[] = [];

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

  const list = async (prefix: string, delimiter?: string) => {
    const folders: string[] = [];
    const files: { key: string; etag?: string }[] = [];
    let token: string | undefined;
    do {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each page needs the previous page's continuation token.
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: delimiter,
          ContinuationToken: token,
        }),
      );
      for (const folder of page.CommonPrefixes ?? [])
        if (folder.Prefix) folders.push(folder.Prefix);
      for (const object of page.Contents ?? []) {
        if (object.Key) files.push({ key: object.Key, etag: object.ETag });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { folders, files };
  };

  const remoteEtag = async (key: string) => {
    try {
      const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return object.ETag ?? '';
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
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
      if (isMissing(error)) {
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
    // A file the catalog just moved here is still at its old key until the next sync.
    if (pendingRemote.some((operation) => operation.to === key)) await sync();
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

  // The local copy is the one object storage holds: nothing in it waits to be uploaded.
  const isStoredCopy = (filePath: string) => {
    const local = statSync(filePath, { throwIfNoEntry: false });
    const previous = synced.get(filePath);
    return (
      !!local && !!previous && previous.size === local.size && previous.mtimeMs === local.mtimeMs
    );
  };

  // Drops stored copies under a folder; reads download them again. Returns how many went.
  const dropStoredCopies = (directory: string) => {
    const files: string[] = [];
    walk(directory, files);
    let dropped = 0;
    for (const filePath of files) {
      if (!isStoredCopy(filePath)) continue;
      rmSync(filePath, { force: true });
      synced.delete(filePath);
      dropped += 1;
    }
    return dropped;
  };

  // Keeps a file beside the folders current, unless this instance changed it and has not uploaded it.
  const refreshFile = async (key: string, etag: string | undefined) => {
    knownRemote.add(key);
    missingRemote.delete(key);
    const filePath = pathFor(key);
    const previous = remoteEtags.get(key)?.etag;
    if (previous === undefined) rememberEtag(key, etag);
    if (!existsSync(filePath)) return download(key, filePath);
    const replaced = previous !== undefined && etag !== undefined && previous !== etag;
    return replaced && isStoredCopy(filePath) && download(key, filePath);
  };

  const refreshFolder = async (folder: string, manifestName: string) => {
    const key = `${folder}${manifestName}`;
    const etag = await remoteEtag(key);
    // A folder without a manifest is still uploading or was left behind.
    if (etag === null) return { listed: false, changed: false };
    const filePath = pathFor(key);
    const current = existsSync(filePath);
    // This instance installed or changed the folder and has not uploaded it yet: its copy wins.
    if (current && !isStoredCopy(filePath)) return { listed: true, changed: false };
    if (current && remoteEtags.get(key)?.etag === etag) return { listed: true, changed: false };
    dropStoredCopies(pathFor(folder));
    removeEmptyDirectories(pathFor(folder));
    await download(key, filePath);
    // Subfolders exist locally even before their files are read, so optional layers are detected.
    for (const subfolder of (await list(folder, '/')).folders) {
      mkdirSync(pathFor(subfolder), { recursive: true });
    }
    return { listed: true, changed: true };
  };

  const isEvictable = (key: string) => {
    const lower = key.toLowerCase();
    return (
      EVICTABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) &&
      !PINNED_SEGMENTS.some((segment) => `/${key}`.includes(segment))
    );
  };

  const evictBeyondBudget = (files: string[]) => {
    let total = 0;
    const candidates: { filePath: string; key: string; size: number; usedAt: number }[] = [];
    for (const filePath of files) {
      const stat = statSync(filePath, { throwIfNoEntry: false });
      const key = keyFor(filePath);
      if (!stat || !key || !isEvictable(key)) continue;
      total += stat.size;
      const previous = synced.get(filePath);
      // Only a copy that object storage already holds unchanged can go.
      if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) continue;
      candidates.push({
        filePath,
        key,
        size: stat.size,
        usedAt: Math.max(stat.atimeMs, stat.mtimeMs),
      });
    }
    candidates.sort((left, right) => left.usedAt - right.usedAt);
    for (const candidate of candidates) {
      if (total <= localBudgetBytes) return;
      rmSync(candidate.filePath, { force: true });
      // Forget the local copy instead of treating it as a deletion, so sync keeps the remote one.
      synced.delete(candidate.filePath);
      knownRemote.add(candidate.key);
      missingRemote.delete(candidate.key);
      total -= candidate.size;
    }
  };

  // Sequential, so a file archived and restored before one sync moves twice in order.
  const applyPendingRemote = async () => {
    let deleted = 0;
    while (pendingRemote.length > 0) {
      const { from, to } = pendingRemote.shift()!;
      try {
        if (to) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Moves apply in request order.
          const copy = await client.send(
            new CopyObjectCommand({
              Bucket: bucket,
              Key: to,
              CopySource: `${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
              MetadataDirective: 'COPY',
            }),
          );
          rememberEtag(to, copy.CopyObjectResult?.ETag);
        }
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Delete only after the copy.
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
        if (!to) deleted += 1;
      } catch (error) {
        // A source that is already gone has nothing to move; the catalog row is the truth.
        if (!isMissing(error)) throw error;
      }
      remoteEtags.delete(from);
      knownRemote.delete(from);
    }
    return deleted;
  };

  const syncOnce = async () => {
    const remoteDeleted = await applyPendingRemote();
    const files: string[] = [];
    walk(root, files);
    const present = new Set(files);
    const changed: { filePath: string; key: string; size: number; mtimeMs: number }[] = [];
    let deleted = 0;
    for (const filePath of files) {
      const stat = statSync(filePath, { throwIfNoEntry: false });
      const key = keyFor(filePath);
      if (!stat || !key) continue;
      const previous = synced.get(filePath);
      if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
      changed.push({ filePath, key, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    await eachLimited(changed, TRANSFER_CONCURRENCY, async ({ filePath, key, size, mtimeMs }) => {
      const put = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: readFileSync(filePath),
          Metadata: { [MTIME_METADATA]: String(Math.floor(mtimeMs)) },
        }),
      );
      rememberEtag(key, put.ETag);
      synced.set(filePath, { size, mtimeMs });
      knownRemote.add(key);
      missingRemote.delete(key);
    });
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
    evictBeyondBudget(files.filter((filePath) => existsSync(filePath)));
    return { uploaded: changed.length, deleted: deleted + remoteDeleted };
  };

  const sync = () => {
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
  };

  const queueRemote = (from: string, to: string | null) => {
    const fromKey = keyFor(from);
    const toKey = to === null ? null : keyFor(to);
    if (!fromKey || (to !== null && !toKey)) return;
    pendingRemote.push({ from: fromKey, to: toKey });
    missingRemote.delete(fromKey);
    if (toKey) {
      knownRemote.add(toKey);
      missingRemote.delete(toKey);
    }
  };

  return {
    root,
    hydrate,
    async hydrateAll(filePaths) {
      const unique = [...new Set([...filePaths].filter((item): item is string => !!item))];
      await Promise.all(unique.map((filePath) => hydrate(filePath)));
    },
    async hydrateFolders(prefix, manifestName) {
      const startedAt = Date.now();
      const { folders, files } = await list(prefix, '/');
      const listed = new Set<string>();
      let changed = 0;
      for (const { key, etag } of files) {
        listed.add(key);
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Files beside the folders are a few small markers.
        if (await refreshFile(key, etag)) changed += 1;
      }
      const refreshed = await Promise.all(
        folders.map(async (folder) => ({
          key: `${folder}${manifestName}`,
          ...(await refreshFolder(folder, manifestName)),
        })),
      );
      for (const folder of refreshed) {
        if (folder.listed) listed.add(folder.key);
        if (folder.changed) changed += 1;
      }
      for (const [key, { seenAt }] of [...remoteEtags]) {
        if (!key.startsWith(prefix) || listed.has(key)) continue;
        if (seenAt > startedAt - LISTING_GRACE_MS) continue;
        const [name, rest] = key.slice(prefix.length).split('/', 2);
        if (rest !== undefined && rest !== manifestName) continue;
        remoteEtags.delete(key);
        knownRemote.delete(key);
        // A removed folder goes with every stored copy in it; a changed, unuploaded file stays.
        const target = pathFor(rest === undefined ? key : `${prefix}${name}`);
        if (rest === undefined) {
          if (!isStoredCopy(target)) continue;
          rmSync(target, { force: true });
          synced.delete(target);
          changed += 1;
        } else {
          changed += dropStoredCopies(target);
          removeEmptyDirectories(target);
        }
      }
      return changed;
    },
    async removePrefix(prefix) {
      const { files } = await list(prefix);
      await eachLimited(files, TRANSFER_CONCURRENCY, async ({ key }) => {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        remoteEtags.delete(key);
        knownRemote.delete(key);
        synced.delete(pathFor(key));
      });
      return files.length;
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
    moveRemote: (from, to) => queueRemote(from, to),
    removeRemote: (filePath) => queueRemote(filePath, null),
    sync,
  };
}

function isMissing(error: unknown) {
  const name = (error as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

/** Removes the directory if nothing but empty directories is left in it. */
function removeEmptyDirectories(directory: string): boolean {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  const empty = entries.every(
    (entry) => entry.isDirectory() && removeEmptyDirectories(path.join(directory, entry.name)),
  );
  if (empty) rmSync(directory, { recursive: true, force: true });
  return empty;
}

/** Runs `run` over every item with at most `limit` in flight. */
async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each lane runs one transfer at a time.
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
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
