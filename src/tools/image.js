import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { safeResolve } from './safe-path.js';

const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg', 'avif'];

// Discord's CDN (and some other hosts) sit behind Cloudflare bot protection
// that silently 403s server-side fetches with no User-Agent header.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; DiscordClaudeBot/1.0)',
};

async function downloadBuffer(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Knock a flat background out to transparent, in place on an RGBA buffer.
 *
 * This is a flood fill inward from the border rather than a global colour key,
 * and the distinction matters: artwork is frequently light-on-light (pale
 * subject on white paper, a product shot on a seamless backdrop). Clearing
 * every pixel that matches the background colour punches holes straight
 * through the subject's own light areas. Only pixels reachable from the edge
 * are background by definition, so interiors are safe by construction.
 *
 * @param {Buffer} data - Raw RGBA pixels, mutated in place
 * @returns {number} Count of pixels cleared
 */
function knockOutBackground(data, width, height, channels, tolerance) {
  // Sample the backdrop from the top-left corner.
  const [br, bg, bb] = [data[0], data[1], data[2]];

  const isBackground = (i) =>
    Math.abs(data[i] - br) <= tolerance &&
    Math.abs(data[i + 1] - bg) <= tolerance &&
    Math.abs(data[i + 2] - bb) <= tolerance;

  const seen = new Uint8Array(width * height);
  // Pixel-index stack rather than [x,y] pairs — source art is routinely 4000px
  // a side, where per-pixel array allocation dominates the runtime.
  const stack = new Int32Array(width * height);
  let top = 0;
  let cleared = 0;

  for (let x = 0; x < width; x++) {
    stack[top++] = x;
    stack[top++] = (height - 1) * width + x;
  }
  for (let y = 0; y < height; y++) {
    stack[top++] = y * width;
    stack[top++] = y * width + (width - 1);
  }

  while (top > 0) {
    const p = stack[--top];
    if (seen[p]) continue;
    const i = p * channels;
    if (!isBackground(i)) continue;
    seen[p] = 1;
    data[i + 3] = 0;
    cleared++;

    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) stack[top++] = p - 1;
    if (x < width - 1) stack[top++] = p + 1;
    if (y > 0) stack[top++] = p - width;
    if (y < height - 1) stack[top++] = p + width;
  }

  return cleared;
}

/**
 * Resize/convert an image buffer and save it into the website repo's public folder.
 * Shared by the URL-based and Google Drive-based entry points below.
 *
 * @param {Buffer} buffer - Raw image bytes
 * @param {string} outputPath - Where to save it relative to the repo root, e.g. "public/images/logo.webp"
 * @param {object} options
 * @param {number} [options.width] - Max width in px (preserves aspect ratio)
 * @param {number} [options.height] - Max height in px (preserves aspect ratio)
 * @param {string} [options.format] - Output format: webp, png, jpg, avif (default: webp)
 * @param {number} [options.quality] - Quality 1-100 (default: 85)
 * @param {boolean} [options.remove_background] - Knock a flat backdrop out to
 *   transparent and trim to the subject. Forces webp/png, since jpg has no alpha.
 * @param {number} [options.background_tolerance] - How far a pixel may drift from
 *   the sampled backdrop and still count as background (default 22).
 */
export async function saveImageBuffer(buffer, outputPath, options = {}) {
  const {
    width,
    height,
    format = 'webp',
    quality = 85,
    tint,
    remove_background = false,
    background_tolerance = 22,
  } = options;

  if (!SUPPORTED_FORMATS.includes(format)) {
    return `Unsupported format "${format}". Use one of: ${SUPPORTED_FORMATS.join(', ')}`;
  }

  if (tint && !/^#?[0-9a-fA-F]{6}$/.test(tint)) {
    return `Invalid tint "${tint}". Use a hex color like "#4A90D9".`;
  }

  if (remove_background && (format === 'jpg' || format === 'jpeg')) {
    return `Cannot remove the background when saving as ${format} — it has no alpha channel. Use webp or png.`;
  }

  // Get original metadata
  const meta = await sharp(buffer).metadata();

  let pipeline = sharp(buffer);
  let cleared = 0;

  if (remove_background) {
    // Art exported from design tools often already carries alpha; there
    // is no backdrop to remove in that case and a flood fill would be a no-op.
    if (meta.hasAlpha) {
      pipeline = pipeline.trim({ threshold: 0 });
    } else {
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      cleared = knockOutBackground(
        data,
        info.width,
        info.height,
        info.channels,
        background_tolerance,
      );

      pipeline = sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      }).trim({ threshold: 0 }); // drop the now-transparent margin
    }
  }

  if (width || height) {
    pipeline = pipeline.resize(width || null, height || null, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (tint) {
    pipeline = pipeline.tint(tint.startsWith('#') ? tint : `#${tint}`);
  }

  // Convert to the target format
  const formatFn = format === 'jpg' ? 'jpeg' : format;
  pipeline = pipeline[formatFn](
    formatFn === 'webp' && remove_background
      ? { quality, alphaQuality: 100 } // don't let alpha compression fringe the cutout
      : { quality },
  );

  let fullPath;
  try {
    fullPath = safeResolve(outputPath);
  } catch (err) {
    return err.message;
  }

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const info = await pipeline.toFile(fullPath);

  const saved = (info.size / 1024).toFixed(1);
  const orig = meta.width && meta.height ? `${meta.width}×${meta.height}` : 'unknown size';

  const lines = [
    `Image saved to ${outputPath}`,
    `Original: ${orig} (${meta.format})`,
    `Output: ${info.width}×${info.height} ${format}, ${saved} KB`,
  ];
  if (remove_background) {
    lines.push(
      meta.hasAlpha
        ? 'Background: source already had alpha, trimmed to content'
        : `Background: removed, ${cleared.toLocaleString()} px cleared (tolerance ${background_tolerance})`,
    );
  }
  return lines.join('\n');
}

/**
 * Download an image from a URL, optionally resize it, convert the format,
 * and save it to the website repo's public folder.
 *
 * @param {string} url - Image URL (Discord attachment, etc.)
 * @param {string} outputPath - Where to save it relative to the repo root, e.g. "public/images/logo.webp"
 * @param {object} options - See saveImageBuffer.
 */
export async function processImage(url, outputPath, options = {}) {
  let buffer;
  try {
    buffer = await downloadBuffer(url);
  } catch (err) {
    return `Error downloading image: ${err.message}`;
  }

  return saveImageBuffer(buffer, outputPath, options);
}

/**
 * Get basic info about an image URL without saving it — useful for
 * inspecting a source file before deciding how to process it.
 */
export async function inspectImage(url) {
  try {
    const buffer = await downloadBuffer(url);
    const meta = await sharp(buffer).metadata();

    const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
    return [
      `Format: ${meta.format}`,
      `Dimensions: ${meta.width}×${meta.height}px`,
      `File size: ${sizeMB} MB`,
      `Color space: ${meta.space || 'unknown'}`,
      `Has alpha: ${meta.hasAlpha ? 'yes' : 'no'}`,
    ].join('\n');
  } catch (err) {
    return `Error inspecting image: ${err.message}`;
  }
}
