// eslint-disable-next-line import/no-extraneous-dependencies
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const { validatePath } = require('./utils.js');

function makeClient() {
  if (!config.s3.accessKeyId || !config.s3.secretAccessKey) {
    throw new Error(
      'Missing S3 credentials. Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY env vars.',
    );
  }
  return new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Upload a single file to the configured bucket.
 * @param {object} args
 * @param {string} args.fileName - Local path to the file (must be inside config.baseDir)
 * @param {string} args.s3Path - Key prefix inside the bucket
 * @param {string} args.s3Key - File name within s3Path. Defaults to basename(fileName).
 * @param {string} args.mimeType - Content-Type for the upload
 * @param {S3Client} [args.s3] - Reuse a client; otherwise one is built per call.
 */
async function uploadFile({
  fileName, s3Path, s3Key, mimeType, s3,
}) {
  const client = s3 || makeClient();
  const baseName = path.basename(fileName);
  const key = path.join(s3Path, s3Key || baseName).replace(/\\/g, '/');
  const fileContent = fs.readFileSync(validatePath(fileName));

  const command = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: fileContent,
    ContentType: mimeType,
    ACL: 'public-read',
  });

  try {
    return await client.send(command);
  } catch (err) {
    console.error('Upload error:', err);
    throw err;
  }
}

/**
 * Walk a results.json (produced by compare.mjs) and upload each referenced
 * image (a, b, diff) plus the results.json itself and a timestamp file.
 * @param {string} dir - Local folder containing results.json (e.g. screenshots/milo)
 * @param {string} [type] - Suffix added to timestamp filename (default '')
 */
async function uploadResultsDir(dir, type = '') {
  const s3 = makeClient();
  const s3Path = '.';
  const resultsPath = path.join(dir, 'results.json');
  const entries = JSON.parse(fs.readFileSync(validatePath(resultsPath)));

  const tasks = [];
  const queueIfPresent = (filePath) => {
    if (filePath) {
      tasks.push(uploadFile({
        fileName: filePath,
        s3Path,
        s3Key: filePath,
        mimeType: 'image/png',
        s3,
      }));
    }
  };

  Object.values(entries).forEach((entry) => {
    if (Array.isArray(entry)) {
      entry.forEach((item) => {
        queueIfPresent(item.a);
        queueIfPresent(item.b);
        queueIfPresent(item.diff);
      });
    } else {
      queueIfPresent(entry.a);
      queueIfPresent(entry.b);
      queueIfPresent(entry.diff);
    }
  });

  await Promise.all(tasks);

  await uploadFile({
    fileName: resultsPath,
    s3Path,
    s3Key: resultsPath,
    mimeType: 'application/json',
    s3,
  });

  const timestampPath = path.join(dir, `timestamp${type}.json`);
  fs.writeFileSync(
    validatePath(timestampPath, { forWriting: true }),
    JSON.stringify([new Date().toLocaleString()], null, 2),
  );
  await uploadFile({
    fileName: timestampPath,
    s3Path,
    s3Key: timestampPath,
    mimeType: 'application/json',
    s3,
  });
}

module.exports = { uploadFile, uploadResultsDir };

// CLI entry: `node upload-s3.js screenshots/milo`
if (require.main === module) {
  const dir = process.argv[2] || `${config.baseDir}/milo`;
  const type = process.argv[3] || '';
  uploadResultsDir(dir, type).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
