import { google } from 'googleapis';
import fs from 'fs/promises';
import { saveImageBuffer } from './image.js';

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json';

let driveClient = null;
let docsClient = null;

async function getClients() {
  if (driveClient && docsClient) return { drive: driveClient, docs: docsClient };

  try {
    const credsRaw = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(credsRaw);

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
      ],
    });

    driveClient = google.drive({ version: 'v3', auth });
    docsClient = google.docs({ version: 'v1', auth });
    return { drive: driveClient, docs: docsClient };
  } catch (err) {
    throw new Error(`Could not initialise Google APIs: ${err.message}. Make sure GOOGLE_CREDENTIALS_PATH is set and the file exists.`);
  }
}

/**
 * Find Google Docs in the configured folder whose name contains `needle`.
 *
 * Structured counterpart to gdriveList, which formats its results for Claude to
 * read and so can't be consumed by other code. Restricted to Docs because the
 * callers append to results via the Docs API, which won't accept a PDF or sheet.
 *
 * @param {string} needle - Case-insensitive substring to match against the name
 * @returns {Promise<Array<{id: string, name: string}>>} Matches, newest first
 * @throws {Error} If the folder isn't configured or the Drive call fails
 */
export async function findDocsByName(needle, folderId) {
  if (!folderId) throw new Error('No Google Drive folder configured for this project');
  const { drive } = await getClients();

  const res = await drive.files.list({
    q: [
      `'${folderId}' in parents`,
      'trashed = false',
      "mimeType = 'application/vnd.google-apps.document'",
    ].join(' and '),
    fields: 'files(id, name)',
    orderBy: 'modifiedTime desc',
    pageSize: 100,
  });

  // Filter client-side rather than with Drive's `name contains`, whose matching
  // rules are token-based and would miss a doc named "Project-TODO".
  const lower = needle.toLowerCase();
  return (res.data.files || []).filter((f) => f.name.toLowerCase().includes(lower));
}

export async function gdriveList(folderId) {
  try {
    if (!folderId) return 'No Google Drive folder is configured for this project.';
    const { drive } = await getClients();

    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
    });

    const files = res.data.files || [];
    if (files.length === 0) return 'No files found in the configured Drive folder.';

    const lines = files.map(f => {
      const type = f.mimeType.includes('folder') ? '📁' :
                   f.mimeType.includes('document') ? '📝' :
                   f.mimeType.includes('spreadsheet') ? '📊' :
                   f.mimeType.includes('image') ? '🖼️' : '📄';
      const date = new Date(f.modifiedTime).toLocaleDateString();
      return `${type} ${f.name}  (id: ${f.id}, modified: ${date})`;
    });

    return `Drive folder contents:\n\n${lines.join('\n')}`;
  } catch (err) {
    return `Error listing Drive: ${err.message}`;
  }
}

export async function gdriveRead(fileId) {
  try {
    const { drive } = await getClients();

    const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const { mimeType, name } = meta.data;

    let content;

    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
      content = res.data;
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export({ fileId, mimeType: 'text/csv' });
      content = res.data;
    } else if (mimeType.startsWith('text/')) {
      const res = await drive.files.get({ fileId, alt: 'media' });
      content = res.data;
    } else {
      return `"${name}" is a ${mimeType} file — I can read Google Docs, Sheets, and plain text files.`;
    }

    const MAX_CHARS = 8000;
    const truncated = content.length > MAX_CHARS
      ? content.slice(0, MAX_CHARS) + `\n\n[... truncated — doc is ${content.length} chars total]`
      : content;

    return `Contents of "${name}":\n\n${truncated}`;
  } catch (err) {
    return `Error reading Drive file: ${err.message}`;
  }
}

/**
 * Download an image file from the configured Drive folder, resize/convert it,
 * and save it into the website repo's public folder. Mirrors process_image
 * but pulls the source bytes straight from Drive via the authenticated
 * service account instead of an unauthenticated URL fetch.
 */
export async function gdriveProcessImage(fileId, outputPath, options = {}) {
  try {
    const { drive } = await getClients();

    const meta = await drive.files.get({ fileId, fields: 'name, mimeType' });
    const { name, mimeType } = meta.data;

    if (!mimeType.startsWith('image/')) {
      return `"${name}" is a ${mimeType} file, not an image.`;
    }

    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(res.data);

    return saveImageBuffer(buffer, outputPath, options);
  } catch (err) {
    return `Error downloading Drive image: ${err.message}`;
  }
}

/**
 * Create a new Google Doc in the configured Drive folder with the given content.
 */
export async function gdriveCreateDoc(name, content, folderId) {
  try {
    if (!folderId) return 'No Google Drive folder is configured for this project.';
    const { drive, docs } = await getClients();

    // Create the empty doc in the right folder
    const file = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.document',
        parents: [folderId],
      },
      fields: 'id, name, webViewLink',
    });

    const docId = file.data.id;

    // Insert the content
    if (content) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: 1 },
              text: content,
            },
          }],
        },
      });
    }

    return `Created Google Doc "${file.data.name}"\nLink: ${file.data.webViewLink}\nID: ${docId}`;
  } catch (err) {
    return `Error creating doc: ${err.message}`;
  }
}

/**
 * Append text to the end of an existing Google Doc.
 */
export async function gdriveAppendDoc(fileId, content) {
  try {
    const { drive, docs } = await getClients();

    // Get the doc's current length so we know where to append
    const doc = await docs.documents.get({ documentId: fileId });
    const meta = await drive.files.get({ fileId, fields: 'name' });

    // The end index is the last character position in the doc body
    const endIndex = doc.data.body.content.at(-1).endIndex - 1;

    await docs.documents.batchUpdate({
      documentId: fileId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: endIndex },
            text: '\n' + content,
          },
        }],
      },
    });

    return `Appended content to "${meta.data.name}"`;
  } catch (err) {
    return `Error appending to doc: ${err.message}`;
  }
}
