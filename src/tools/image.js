import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';

const REPO_PATH = process.env.REPO_PATH || './repo';

const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg', 'avif'];

/**
 * Download an image from a URL, optionally resize it, convert the format,
 * and save it to the website repo's public folder.
 *
 * @param {string} url - Image URL (Discord attachment, Google Drive export, etc.)
 * @param {string} outputPath - Where to save it relative to the repo root, e.g. "public/images/blobby.webp"
 * @param {object} options
 * @param {number} [options.width] - Max width in px (preserves aspect ratio)
 * @param {number} [options.height] - Max height in px (preserves aspect ratio)
 * @param {string} [options.format] - Output format: webp, png, jpg, avif (default: webp)
 * @param {number} [options.quality] - Quality 1-100 (default: 85)
 */
export async function processImage(url, outputPath, options = {}) {
  const {
    width,
    height,
    format = 'webp',
    quality = 85,
  } = options;

  if (!SUPPORTED_FORMATS.includes(format)) {
    return `Unsupported format "${format}". Use one of: ${SUPPORTED_FORMATS.join(', ')}`;
  }

  // Download the image
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) return `Failed to download image: ${res.status} ${res.statusText}`;
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return `Error downloading image: ${err.message}`;
  }

  // Get original metadata
  const meta = await sharp(buffer).metadata();

  // Build the processing pipeline
  let pipeline = sharp(buffer);

  if (width || height) {
    pipeline = pipeline.resize(width || null, height || null, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Convert to the target format
  const formatFn = format === 'jpg' ? 'jpeg' : format;
  pipeline = pipeline[formatFn]({ quality });

  // Save to repo
  const fullPath = path.resolve(REPO_PATH, outputPath);
  // Safety check — stay within repo
  if (!fullPath.startsWith(path.resolve(REPO_PATH))) {
    return `Output path "${outputPath}" is outside the repo.`;
  }

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const info = await pipeline.toFile(fullPath);

  const saved = (info.size / 1024).toFixed(1);
  const orig = meta.width && meta.height ? `${meta.width}×${meta.height}` : 'unknown size';

  return `Image saved to ${outputPath}\nOriginal: ${orig} (${meta.format})\nOutput: ${info.width}×${info.height} ${format}, ${saved} KB`;
}

/**
 * Get basic info about an image URL without saving it — useful for
 * inspecting a Procreate export before deciding how to process it.
 */
export async function inspectImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return `Failed to download image: ${res.status} ${res.statusText}`;
    const buffer = Buffer.from(await res.arrayBuffer());
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
