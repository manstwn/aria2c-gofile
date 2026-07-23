const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');

const IMAGES_DIR = path.resolve(__dirname, '../data/image');

/**
 * Ensure data/image storage directory exists
 */
function initImageStorage() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }
}

/**
 * Check if ffmpeg is available on system
 */
function isFFmpegAvailable() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extract exact video duration in seconds via ffprobe or metadata fallback
 */
function getVideoDuration(filePath, meta = {}) {
  // 1. Primary: Use ffprobe for 100% exact video duration from file container
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { timeout: 5000 }).toString().trim();
    const parsedSecs = parseFloat(output);
    if (!isNaN(parsedSecs) && parsedSecs > 0) {
      return Math.round(parsedSecs);
    }
  } catch (e) {}

  // 2. Secondary: Parse HH:MM:SS or MM:SS from metadata
  if (meta.duration_formatted) {
    const parts = meta.duration_formatted.split(':').map(p => parseInt(p, 10));
    if (parts.length === 3 && !parts.some(isNaN)) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2 && !parts.some(isNaN)) {
      return parts[0] * 60 + parts[1];
    }
  }

  if (meta.duration_seconds && meta.duration_seconds > 0) {
    return meta.duration_seconds;
  }

  return 300; // Fallback to 5 minutes (300 seconds) if unknown
}

/**
 * Helper to run ffmpeg seeking frame extraction asynchronously
 */
function extractVideoFrame(filePath, timestampSeconds, outputPath) {
  return new Promise((resolve) => {
    // ffmpeg -ss <timestamp> -i <filePath> -vframes 1 -q:v 2 -y <outputPath>
    const args = [
      '-ss', timestampSeconds.toString(),
      '-i', filePath,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      outputPath
    ];

    execFile('ffmpeg', args, { timeout: 10000 }, (error) => {
      if (!error && fs.existsSync(outputPath)) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * Generate thumbnails for image or 15 frame screenshots across video duration
 * @param {string} filePath Absolute path to completed download file on disk
 * @param {string} fileId Record ID (e.g. gt_1784836215_101)
 * @param {object} meta Extracted file metadata object
 * @returns {Promise<Array<string>>} Array of web accessible image URL paths
 */
async function generateThumbnails(filePath, fileId, meta = {}) {
  initImageStorage();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const category = meta.category || 'file';
  const thumbnails = [];

  // =========================================================================
  // IMAGE THUMBNAIL GENERATION
  // =========================================================================
  if (category === 'image') {
    try {
      const outFilename = `${fileId}-thumb.jpg`;
      const outPath = path.join(IMAGES_DIR, outFilename);
      fs.copyFileSync(filePath, outPath);
      console.log(`[Thumbnails] Saved image thumbnail: ${outFilename}`);
      return [`/data/image/${outFilename}`];
    } catch (err) {
      console.warn(`[Thumbnails Warning] Could not copy image thumbnail:`, err.message);
      return [];
    }
  }

  // =========================================================================
  // VIDEO 15-FRAME SCREENSHOT GENERATION ACROSS REAL DURATION
  // =========================================================================
  if (category === 'video') {
    if (!isFFmpegAvailable()) {
      console.warn(`[Thumbnails Info] ffmpeg is not installed on this VPS/system. Skipping 15-frame video screenshots. (Install with: apt install ffmpeg)`);
      return [];
    }

    const duration = getVideoDuration(filePath, meta);
    const count = 15;
    const interval = duration / (count + 1);

    const formattedMins = (duration / 60).toFixed(1);
    console.log(`[Thumbnails] Generating ${count} video frame screenshots for ${path.basename(filePath)} (Total Duration: ${duration}s / ${formattedMins} mins, Interval: Every ${interval.toFixed(1)}s)...`);

    for (let i = 1; i <= count; i++) {
      const targetTime = parseFloat((interval * i).toFixed(1));
      const outFilename = `${fileId}-image-${i}.jpg`;
      const outPath = path.join(IMAGES_DIR, outFilename);

      const success = await extractVideoFrame(filePath, targetTime, outPath);
      if (success) {
        thumbnails.push(`/data/image/${outFilename}`);
      }
    }

    console.log(`[Thumbnails] ✅ Generated ${thumbnails.length}/${count} video frame screenshots for ${fileId}!`);
    return thumbnails;
  }

  return [];
}

module.exports = {
  IMAGES_DIR,
  generateThumbnails
};
