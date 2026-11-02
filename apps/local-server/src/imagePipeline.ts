/**
 * Runtime Catalog Entry thumbnails and reference WebP. Authoring cover-fit,
 * flatten, raw pixels, and SVG raster stay on `sharpAuthoringAdapter.ts`.
 */
export interface ResizeWebpOptions {
  maxEdge: number;
  quality: number;
}

export interface EncodedWebp {
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

/** First Bun release with `Bun.Image`; local-server refuses to start below it. */
export const MIN_BUN_VERSION = '1.3.14';

function getBunImage() {
  const Image = globalThis.Bun?.Image;
  return typeof Image === 'function' ? Image : null;
}

// Hosted mode runs on Node (ADR 0012), where Bun.Image does not exist; sharp produces the same
// inside-fit WebP there. It is loaded lazily so the Bun hot path never imports it.
async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error(
      `Bun.Image is required for Catalog Entry thumbnails and reference WebP conversion. Run local-server with Bun ${MIN_BUN_VERSION} or later.`,
    );
  }
}

const INSIDE_FIT = { fit: 'inside', withoutEnlargement: true } as const;

export async function encodeResizedWebpFromPath(
  sourcePath: string,
  destinationPath: string,
  options: ResizeWebpOptions,
) {
  const Image = getBunImage();
  if (!Image) {
    const sharp = await loadSharp();
    await sharp(sourcePath)
      .resize(options.maxEdge, options.maxEdge, INSIDE_FIT)
      .webp({ quality: options.quality })
      .toFile(destinationPath);
    return;
  }
  await new Image(sourcePath)
    .resize(options.maxEdge, options.maxEdge, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: options.quality })
    .write(destinationPath);
}

export async function encodeResizedWebpFromBytes(
  bytes: Uint8Array,
  options: ResizeWebpOptions,
): Promise<EncodedWebp> {
  const Image = getBunImage();
  if (!Image) {
    const sharp = await loadSharp();
    const { data, info } = await sharp(bytes)
      .resize(options.maxEdge, options.maxEdge, INSIDE_FIT)
      .webp({ quality: options.quality })
      .toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(data), width: info.width ?? null, height: info.height ?? null };
  }
  const image = new Image(bytes)
    .resize(options.maxEdge, options.maxEdge, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: options.quality });
  const encoded = await image.bytes();
  return {
    bytes: encoded,
    width: image.width ?? null,
    height: image.height ?? null,
  };
}

export async function readImageMetadata(bytes: Uint8Array) {
  const Image = getBunImage();
  if (!Image) return (await loadSharp())(bytes).metadata();
  return new Image(bytes).metadata();
}

export function isWebpPayload(bytes: Uint8Array) {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}
