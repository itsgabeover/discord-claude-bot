import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { safeResolve } from './safe-path.js';

const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg', 'avif'];

// Peak memory for the background knockout is ~9 bytes per source pixel: 4 for
// the raw RGBA buffer sharp hands back, 1 for `seen`, 4 for `stack` — before
// sharp's own input and output buffers on top. A 4000px-square source is
// therefore ~144MB inside this one function, which on a 512MB Render instance
// is the difference between processing a hero image and being OOM-killed.
// Capping the working resolution holds it near 36MB.
const MAX_FILL_PIXELS = parseInt(process.env.MAX_FILL_PIXELS || '4000000', 10);

// Discord's CDN (and some other hosts) sit behind Cloudflare bot protection
// that silently 403s server-side fetches with no User-Agent header.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; DiscordClaudeBot/1.0)',
};

/**
 * Exported because the Agent SDK path needs it too: unlike the Messages API,
 * `query()` won't accept an image by URL, so Discord attachments have to be
 * fetched and base64-encoded before they can be sent. That fetch needs the same
 * User-Agent workaround above, which is exactly why this is shared rather than
 * reimplemented in ../agent.js.
 */
export async function downloadBuffer(url) {
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
  //
  // `seen` is set when a pixel is PUSHED, not when it is popped. That ordering
  // is load-bearing twice over. Marking on pop lets a pixel be pushed once per
  // neighbour, so `top` can reach 4×(width×height) and run off the end of a
  // Int32Array sized width×height — and an out-of-bounds typed-array write is
  // silently discarded in JS, so the fill would quietly stop expanding and
  // leave background behind with no error to explain it. Marking on push makes
  // each pixel enter the stack at most once, which bounds `top` by exactly
  // width×height and keeps this buffer at its allocated size.
  const stack = new Int32Array(width * height);
  let top = 0;
  let cleared = 0;

  const push = (p) => {
    if (!seen[p]) {
      seen[p] = 1;
      stack[top++] = p;
    }
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + (width - 1));
  }

  while (top > 0) {
    const p = stack[--top];
    const i = p * channels;
    // Seen-but-not-background: visited so it is never re-queued, but it is the
    // subject rather than the backdrop, so the fill stops rather than crossing.
    if (!isBackground(i)) continue;
    data[i + 3] = 0;
    cleared++;

    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
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
 * @param {string} options.repoPath - Root of the project's checkout. Required —
 *   with several projects in one process, a default would risk writing one
 *   project's asset into another's repo.
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
    repoPath,
  } = options;

  if (!repoPath) return 'No project repo path was provided for the image output.';

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
  let fillScaledTo = null;

  if (remove_background) {
    // Art exported from design tools often already carries alpha; there
    // is no backdrop to remove in that case and a flood fill would be a no-op.
    if (meta.hasAlpha) {
      pipeline = pipeline.trim({ threshold: 0 });
    } else {
      // Downscale before the knockout when the source is big enough to threaten
      // the heap. This has to happen ahead of the fill rather than after it,
      // because the buffers being bounded are the ones the fill allocates.
      //
      // The tradeoff is real but small: resampling softens the backdrop edge, so
      // `background_tolerance` has a marginally harder job separating subject
      // from background. That is worth it against an OOM kill, and the cap sits
      // well above the resolution web output actually ships at.
      const sourcePixels = (meta.width || 0) * (meta.height || 0);
      if (sourcePixels > MAX_FILL_PIXELS) {
        const scale = Math.sqrt(MAX_FILL_PIXELS / sourcePixels);
        fillScaledTo = {
          width: Math.round(meta.width * scale),
          height: Math.round(meta.height * scale),
        };
        console.log(
          `[image] source ${meta.width}×${meta.height} exceeds the ${MAX_FILL_PIXELS.toLocaleString()}px ` +
            `background-removal cap — filling at ${fillScaledTo.width}×${fillScaledTo.height}`,
        );
        pipeline = pipeline.resize(fillScaledTo.width, fillScaledTo.height, { fit: 'inside' });
      }

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
    fullPath = safeResolve(outputPath, repoPath);
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
    // Surfaced rather than silent: the cutout edge was computed at a lower
    // resolution than the source, which is worth knowing if the result looks
    // softer than expected.
    if (fillScaledTo) {
      lines.push(
        `Note: source downscaled to ${fillScaledTo.width}×${fillScaledTo.height} for background removal (memory cap)`,
      );
    }
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
