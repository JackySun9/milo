/**
 * Unit + light integration tests for the Figma compare helpers.
 * Run with: npm run test:screenshot-diff   (node --test, no browser needed)
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
  parseFigmaUrl,
  buildImagesApiUrl,
  pickSingleUrl,
  pickSingleViewport,
  requireSelector,
  requireFigmaToken,
  readPngSize,
  exportFigmaNodePng,
  buildResultEntry,
} = require('../lib/figma.js');

// Minimal valid PNG header built by hand so the tests need no binary fixtures.
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(typeof zlib.crc32 === 'function' ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('parseFigmaUrl', () => {
  test('normalizes a prototype hyphen node-id to the API colon form', () => {
    const out = parseFigmaUrl('https://www.figma.com/design/abc123XYZ/My-File?node-id=83-45998');
    assert.deepEqual(out, { fileKey: 'abc123XYZ', nodeId: '83:45998' });
  });

  test('preserves an already-colon node-id (url-encoded)', () => {
    const out = parseFigmaUrl('https://www.figma.com/file/abc123XYZ/My-File?node-id=83%3A45998');
    assert.equal(out.nodeId, '83:45998');
  });

  test('preserves a literal colon node-id', () => {
    const out = parseFigmaUrl('https://www.figma.com/proto/KEY1/Name?node-id=12:34&t=xyz');
    assert.deepEqual(out, { fileKey: 'KEY1', nodeId: '12:34' });
  });

  test('accepts the /design/ and /file/ path forms', () => {
    assert.equal(parseFigmaUrl('https://figma.com/design/K/N?node-id=1-2').fileKey, 'K');
    assert.equal(parseFigmaUrl('https://figma.com/file/K/N?node-id=1-2').fileKey, 'K');
  });

  test('rejects empty, malformed, non-figma and node-less URLs', () => {
    assert.throws(() => parseFigmaUrl(''), /required/);
    assert.throws(() => parseFigmaUrl('not a url'), /Malformed figma_url/);
    assert.throws(() => parseFigmaUrl('ftp://www.figma.com/design/K/N?node-id=1-2'), /Malformed figma_url/);
    assert.throws(() => parseFigmaUrl('https://example.com/design/K/N?node-id=1-2'), /Not a figma\.com URL/);
    assert.throws(() => parseFigmaUrl('https://www.figma.com/community/plugin/1'), /file key/);
    assert.throws(() => parseFigmaUrl('https://www.figma.com/design/K/N'), /missing a node-id/);
    assert.throws(() => parseFigmaUrl('https://www.figma.com/design/K/N?node-id=abc'), /Malformed node-id/);
  });
});

describe('buildImagesApiUrl', () => {
  test('url-encodes the node id and defaults to png @1x', () => {
    const url = buildImagesApiUrl({ fileKey: 'K', nodeId: '83:45998' });
    assert.ok(url.startsWith('https://api.figma.com/v1/images/K?'));
    assert.ok(url.includes('ids=83%3A45998'), url);
    assert.ok(url.includes('format=png'));
    assert.ok(url.includes('scale=1'));
  });

  test('rejects missing ids and unsupported scales', () => {
    assert.throws(() => buildImagesApiUrl({ fileKey: '', nodeId: '1:2' }), /required/);
    assert.throws(() => buildImagesApiUrl({ fileKey: 'K', nodeId: '1:2', scale: 0 }), /scale/);
    assert.throws(() => buildImagesApiUrl({ fileKey: 'K', nodeId: '1:2', scale: 9 }), /scale/);
  });
});

describe('input guards', () => {
  test('pickSingleUrl accepts exactly one http(s) url', () => {
    assert.equal(pickSingleUrl('  https://a.com/p  '), 'https://a.com/p');
    assert.equal(pickSingleUrl('# note\nhttps://a.com/p\n'), 'https://a.com/p');
  });

  test('pickSingleUrl rejects none, many and A|B pairs', () => {
    assert.throws(() => pickSingleUrl(''), /got none/);
    assert.throws(() => pickSingleUrl('https://a.com\nhttps://b.com'), /exactly one web URL, got 2/);
    assert.throws(() => pickSingleUrl('https://a.com | https://b.com'), /A\|B url pairs/);
    assert.throws(() => pickSingleUrl('ftp://a.com'), /Invalid web URL/);
  });

  test('pickSingleViewport enforces one known viewport', () => {
    assert.equal(pickSingleViewport('ipad', ['chrome', 'ipad', 'iphone']), 'ipad');
    assert.throws(() => pickSingleViewport('chrome,ipad', ['chrome', 'ipad']), /exactly one viewport/);
    assert.throws(() => pickSingleViewport('', ['chrome']), /exactly one viewport/);
    assert.throws(() => pickSingleViewport('watch', ['chrome']), /Unknown viewport/);
  });

  test('selector and token are required', () => {
    assert.equal(requireSelector('  .marquee '), '.marquee');
    assert.throws(() => requireSelector('   '), /`selector` is required/);
    assert.equal(requireFigmaToken({ FIGMA_TOKEN: 'tok' }), 'tok');
    assert.throws(() => requireFigmaToken({}), /FIGMA_TOKEN is required/);
  });
});

describe('readPngSize', () => {
  test('reads dimensions from the IHDR chunk', () => {
    assert.deepEqual(readPngSize(makePng(640, 480)), { width: 640, height: 480 });
  });

  test('rejects non-PNG input', () => {
    assert.throws(() => readPngSize(Buffer.from('nope')), /Not a PNG/);
  });
});

describe('exportFigmaNodePng (mocked Figma API)', () => {
  const png = makePng(320, 200);
  const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);

  function mockFetch(handlers) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      const handler = handlers.find((h) => url.includes(h.match));
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler.response;
    };
    return { fetchImpl, calls };
  }

  test('sends the token header and downloads the temporary image URL', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: 'api.figma.com',
        response: { ok: true, json: async () => ({ err: null, images: { '83:45998': 'https://figma-alpha.s3/img.png' } }) },
      },
      { match: 'figma-alpha', response: { ok: true, arrayBuffer: async () => toArrayBuffer(png) } },
    ]);

    const out = await exportFigmaNodePng({
      fileKey: 'K', nodeId: '83:45998', token: 'tok', fetchImpl,
    });

    assert.deepEqual(readPngSize(out), { width: 320, height: 200 });
    assert.equal(calls[0].opts.headers['X-Figma-Token'], 'tok');
    assert.ok(calls[0].url.includes('ids=83%3A45998'));
    assert.equal(calls.length, 2, 'image URL is downloaded immediately');
  });

  test('fails when the image map entry is null', async () => {
    const { fetchImpl } = mockFetch([{
      match: 'api.figma.com',
      response: { ok: true, json: async () => ({ err: null, images: { '83:45998': null } }) },
    }]);
    await assert.rejects(
      exportFigmaNodePng({
        fileKey: 'K', nodeId: '83:45998', token: 'tok', fetchImpl,
      }),
      /did not return an image for node 83:45998/,
    );
  });

  test('fails when the node is missing from the image map', async () => {
    const { fetchImpl } = mockFetch([{
      match: 'api.figma.com',
      response: { ok: true, json: async () => ({ err: null, images: {} }) },
    }]);
    await assert.rejects(
      exportFigmaNodePng({
        fileKey: 'K', nodeId: '1:2', token: 'tok', fetchImpl,
      }),
      /did not return an image/,
    );
  });

  test('surfaces auth failures, API errors and a missing token explicitly', async () => {
    const forbidden = mockFetch([{ match: 'api.figma.com', response: { ok: false, status: 403 } }]);
    await assert.rejects(
      exportFigmaNodePng({
        fileKey: 'K', nodeId: '1:2', token: 'bad', fetchImpl: forbidden.fetchImpl,
      }),
      /HTTP 403 \(check FIGMA_TOKEN/,
    );

    const apiErr = mockFetch([{
      match: 'api.figma.com',
      response: { ok: true, json: async () => ({ err: 'Not found' }) },
    }]);
    await assert.rejects(
      exportFigmaNodePng({
        fileKey: 'K', nodeId: '1:2', token: 'tok', fetchImpl: apiErr.fetchImpl,
      }),
      /Figma images API error: Not found/,
    );

    await assert.rejects(
      exportFigmaNodePng({
        fileKey: 'K', nodeId: '1:2', token: '', fetchImpl: mockFetch([]).fetchImpl,
      }),
      /FIGMA_TOKEN is required/,
    );
  });

  test('rejects a non-PNG download', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: 'api.figma.com',
        response: { ok: true, json: async () => ({ images: { '1:2': 'https://figma-alpha.s3/x' } }) },
      },
      {
        match: 'figma-alpha',
        response: { ok: true, arrayBuffer: async () => toArrayBuffer(Buffer.from('<html>gone</html>')) },
      },
    ]);
    await assert.rejects(
      exportFigmaNodePng({
        fileKey: 'K', nodeId: '1:2', token: 'tok', fetchImpl,
      }),
      /Not a PNG/,
    );
  });
});

describe('buildResultEntry', () => {
  test('produces the results.json shape ImageDiff already consumes', () => {
    const entry = buildResultEntry({
      baselinePath: 'screenshots/s/x-a.png',
      candidatePath: 'screenshots/s/x-b.png',
      figmaUrl: 'https://www.figma.com/design/K/N?node-id=1-2',
      webUrl: 'https://a.com/p',
      diffPath: 'screenshots/s/x-diff.png',
    });
    assert.deepEqual(entry, {
      order: 1,
      a: 'screenshots/s/x-a.png',
      b: 'screenshots/s/x-b.png',
      diff: 'screenshots/s/x-diff.png',
      urls: 'https://www.figma.com/design/K/N?node-id=1-2 | https://a.com/p',
    });
  });

  test('omits diff when the images match', () => {
    const entry = buildResultEntry({
      baselinePath: 'a.png', candidatePath: 'b.png', figmaUrl: 'f', webUrl: 'w',
    });
    assert.equal('diff' in entry, false);
  });
});
