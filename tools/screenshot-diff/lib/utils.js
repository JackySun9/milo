// eslint-disable-next-line import/no-extraneous-dependencies
const { getComparator } = require('playwright-core/lib/utils');

const fs = require('fs');
const path = require('path');
const config = require('./config.js');

/**
 * Resolve a path and assert it stays inside the configured base directory.
 * Prevents `../` traversal in user-supplied paths (folder names, S3 keys).
 * @param {string} filePath
 * @param {{allowDirectory?: boolean, forWriting?: boolean}} [options]
 * @returns {string} Absolute, validated path
 */
function validatePath(filePath, options = { allowDirectory: false, forWriting: false }) {
  if (typeof filePath !== 'string') {
    throw new Error(`Invalid path: ${filePath}. Path should be a string.`);
  }

  const absolutePath = path.resolve(filePath);

  if (!absolutePath.startsWith(path.resolve(config.baseDir))) {
    throw new Error(`Path traversal attempt detected: ${filePath}`);
  }

  const dirPath = path.dirname(absolutePath);

  if (options.forWriting) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    } else if (!fs.lstatSync(dirPath).isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }
  } else {
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File or directory does not exist: ${absolutePath}`);
    }

    const stats = fs.lstatSync(absolutePath);
    if (options.allowDirectory && !stats.isFile() && !stats.isDirectory()) {
      throw new Error(`Not a file or directory: ${absolutePath}`);
    } else if (!options.allowDirectory && !stats.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`);
    }
  }

  return absolutePath;
}

/**
 * Pixel-diff two arrays of screenshot results from parallel test runs.
 * Pairs entries by trailing-10-char filename match, writes a `-diff.png`
 * next to each pair where pixels differ.
 * @param {Array<{a: string, urls: string}>} stableArray
 * @param {Array<{a: string, urls: string}>} betaArray
 * @returns {Array<{order: number, a: string, b: string, diff?: string, urls: string}>}
 */
function compareScreenshots(stableArray, betaArray) {
  const results = [];
  const comparator = getComparator('image/png');
  for (let i = 0; i < stableArray.length; i += 1) {
    if (betaArray[i].a.slice(-10) === stableArray[i].a.slice(-10)) {
      const result = {};
      const urls = [];
      result.order = i + 1;
      result.a = `${stableArray[i].a}`;
      result.b = `${betaArray[i].a}`;
      urls.push(stableArray[i].urls);
      urls.push(betaArray[i].urls);
      const stableImage = fs.readFileSync(validatePath(`${stableArray[i].a}`));
      const betaImage = fs.readFileSync(validatePath(`${betaArray[i].a}`));
      const diffImage = comparator(stableImage, betaImage);

      if (diffImage) {
        result.diff = `${stableArray[i].a}-diff.png`;
        fs.writeFileSync(
          validatePath(`${stableArray[i].a}-diff.png`, { forWriting: true }),
          diffImage.diff,
        );
        console.info('Differences found');
      }
      result.urls = urls.join(' | ');
      results.push(result);
    } else {
      console.info('Screenshots are not matched');
      console.info(`${stableArray[i].a} vs ${betaArray[i].a}`);
    }
  }
  return results;
}

function writeResultsToFile(folderPath, testInfo, results) {
  const resultFilePath = `${folderPath}/results-${testInfo.workerIndex}.json`;
  fs.writeFileSync(validatePath(resultFilePath, { forWriting: true }), JSON.stringify(results, null, 2));
}

module.exports = { compareScreenshots, writeResultsToFile, validatePath };
