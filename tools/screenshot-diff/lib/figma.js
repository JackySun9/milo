/**
 * Figma-vs-web comparison helpers.
 *
 * MVP scope: exactly one web URL, one Figma node, one CSS selector and one
 * viewport per run. Everything here is either a pure helper (unit tested in
 * tools/screenshot-diff/test/figma.test.js) or a thin wrapper around the
 * Figma REST API, so the Playwright-dependent runner stays small.
 *
 * Required env for the REST calls:
 *   FIGMA_TOKEN — read-only Figma personal access token
 */

const FIGMA_API_BASE = process.env.FIGMA_API_BASE || 'https://api.figma.com';

// Figma share URLs look like:
//   https://www.figma.com/design/<fileKey>/<slug>?node-id=123-45
//   https://www.figma.com/file/<fileKey>/<slug>?node-id=123%3A45
//   https://www.figma.com/proto/<fileKey>/<slug>?node-id=123:45
const FIGMA_PATH_RE = /^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/|$)/;

/**
 * Parse a Figma share URL into `{ fileKey, nodeId }`.
 * `node-id` is normalized from the URL form (`123-45`) to the API form (`123:45`).
 * Throws with an explicit message for anything malformed.
 * @param {string} url
 * @returns {{fileKey: string, nodeId: string}}
 */
function parseFigmaUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('figma_url is required and must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch (e) {
    throw new Error(`Malformed figma_url: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Malformed figma_url (expected http/https): ${url}`);
  }
  if (!/(^|\.)figma\.com$/i.test(parsed.hostname)) {
    throw new Error(`Not a figma.com URL: ${url}`);
  }
  const match = FIGMA_PATH_RE.exec(parsed.pathname);
  if (!match) {
    throw new Error(`Could not read a Figma file key from: ${url}`);
  }
  const rawNodeId = parsed.searchParams.get('node-id');
  if (!rawNodeId) {
    throw new Error(`figma_url is missing a node-id query parameter: ${url}`);
  }
  const nodeId = rawNodeId.trim().replace(/-/g, ':');
  if (!/^[0-9]+:[0-9]+$/.test(nodeId)) {
    throw new Error(`Malformed node-id '${rawNodeId}' in figma_url: ${url}`);
  }
  return { fileKey: match[1], nodeId };
}

/**
 * Build the Figma images endpoint for one node.
 * @param {{fileKey: string, nodeId: string, scale?: number, format?: string}} args
 * @returns {string}
 */
function buildImagesApiUrl({
  fileKey, nodeId, scale = 1, format = 'png',
}) {
  if (!fileKey || !nodeId) throw new Error('fileKey and nodeId are required');
  if (!(scale > 0 && scale <= 4)) throw new Error(`Unsupported Figma export scale: ${scale}`);
  const params = new URLSearchParams({ ids: nodeId, format, scale: String(scale) });
  return `${FIGMA_API_BASE}/v1/images/${encodeURIComponent(fileKey)}?${params}`;
}

/**
 * Exactly one web URL is supported in MVP. Accepts the same newline-separated
 * `urls` input the dataset Quick Run uses, but rejects pairs and multi-line lists.
 * @param {string} text
 * @returns {string} the single URL
 */
function pickSingleUrl(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new Error('Figma compare needs exactly one web URL in `urls` (got none)');
  }
  if (lines.length > 1) {
    throw new Error(`Figma compare supports exactly one web URL, got ${lines.length}`);
  }
  const [line] = lines;
  if (line.includes('|')) {
    throw new Error(`Figma compare does not support A|B url pairs: ${line}`);
  }
  if (!/^https?:\/\/\S+$/i.test(line)) {
    throw new Error(`Invalid web URL: ${line}`);
  }
  return line;
}

/**
 * Exactly one viewport is supported in MVP.
 * @param {string} text - comma separated viewport list
 * @param {string[]} allowed
 * @returns {string}
 */
function pickSingleViewport(text, allowed) {
  const list = String(text || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (list.length !== 1) {
    throw new Error(`Figma compare supports exactly one viewport, got '${text || ''}'`);
  }
  const [viewport] = list;
  if (allowed && !allowed.includes(viewport)) {
    throw new Error(`Unknown viewport '${viewport}'. Valid: ${allowed.join(', ')}`);
  }
  return viewport;
}

/**
 * Validate the CSS selector input.
 * @param {string} selector
 * @returns {string}
 */
function requireSelector(selector) {
  const value = String(selector || '').trim();
  if (!value) throw new Error('`selector` is required when `figma_url` is set');
  return value;
}

/**
 * Read the read-only Figma token from the environment.
 * @param {object} [env]
 * @returns {string}
 */
function requireFigmaToken(env = process.env) {
  const token = String(env.FIGMA_TOKEN || '').trim();
  if (!token) {
    throw new Error('FIGMA_TOKEN is required for Figma compare. Add a read-only Figma personal access token as the FIGMA_TOKEN repository secret.');
  }
  return token;
}

/**
 * Read width/height out of a PNG IHDR chunk. Avoids pulling in an image
 * decoding dependency just to learn the capture's pixel dimensions.
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width: number, height: number}}
 */
function readPngSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const isPng = bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.subarray(12, 16).toString('latin1') === 'IHDR';
  if (!isPng) throw new Error('Not a PNG buffer');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  return { width, height };
}

/**
 * Export a single Figma node as PNG bytes.
 * @param {object} args
 * @param {string} args.fileKey
 * @param {string} args.nodeId
 * @param {string} args.token - read-only Figma personal access token
 * @param {number} [args.scale=2]
 * @param {Function} [args.fetchImpl=fetch] - injectable for tests
 * @returns {Promise<Buffer>}
 */
async function exportFigmaNodePng({
  fileKey, nodeId, token, scale = 1, fetchImpl,
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('No fetch implementation available');
  if (!token) throw new Error('FIGMA_TOKEN is required for Figma compare');

  const apiUrl = buildImagesApiUrl({ fileKey, nodeId, scale });
  const res = await doFetch(apiUrl, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 401
      ? ' (check FIGMA_TOKEN scope / file access)'
      : '';
    throw new Error(`Figma images API failed: HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body && body.err) throw new Error(`Figma images API error: ${body.err}`);
  const imageUrl = body && body.images && body.images[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma did not return an image for node ${nodeId} — confirm the node exists and is exportable`);
  }

  const imgRes = await doFetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Figma image download failed: HTTP ${imgRes.status}`);
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  readPngSize(bytes); // throws if Figma handed back something that isn't a PNG
  return bytes;
}

/**
 * Build the results.json entry consumed unchanged by nala-auto ImageDiff.
 * `a` is the Figma baseline, `b` is the live web capture.
 * @param {object} args
 * @returns {object}
 */
function buildResultEntry({
  baselinePath, candidatePath, figmaUrl, webUrl, diffPath,
}) {
  const entry = {
    order: 1,
    a: baselinePath,
    b: candidatePath,
    urls: [figmaUrl, webUrl].join(' | '),
  };
  if (diffPath) entry.diff = diffPath;
  return entry;
}

module.exports = {
  FIGMA_API_BASE,
  parseFigmaUrl,
  buildImagesApiUrl,
  pickSingleUrl,
  pickSingleViewport,
  requireSelector,
  requireFigmaToken,
  readPngSize,
  exportFigmaNodePng,
  buildResultEntry,
};
