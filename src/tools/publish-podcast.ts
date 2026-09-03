import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import type {
  FeedBackend,
  FeedResult,
  PodcastMetadata,
  PublishResult,
  StageResult,
} from '../feed/feed-types.js';
import type { StorageBackend } from '../storage/storage-types.js';
import { logger } from '../utils/logger.js';

/** RFC 3339 / ISO 8601 datetime pattern. */
/** Validates a string is a strict RFC 3339 datetime.
 * Rejects values that JavaScript silently normalizes (e.g. 2024-02-30 → 2024-03-01,
 * 2024-01-01T24:00:00Z). Validates date, time, AND offset components.
 */
function isValidRFC3339(raw: string): boolean {
  if (!RFC3339_REGEX.test(raw)) return false;
  // Validate date components
  const dateStr = raw.split('T')[0];
  const dateParts = dateStr.split('-');
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;
  // Use UTC to avoid the 1900 year wrap for years 0-99
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  if (rebuilt.getUTCFullYear() !== year || rebuilt.getUTCMonth() !== month - 1 || rebuilt.getUTCDate() !== day) {
    return false;
  }
  // Validate time and offset components
  const timeOffset = raw.split('T')[1]; // e.g. "12:34:56.000Z" or "12:34:56+05:00"
  // Extract time part (before Z or + or -)
  const timePart = timeOffset.split(/[Z+-]/)[0];
  const timeParts = timePart.split(':');
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  const secondStr = timeParts[2] ?? '0';
  const second = Number(secondStr);
  if (isNaN(hour) || isNaN(minute) || isNaN(second)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  // Validate offset if present: must be +/-HH:MM with valid ranges
  const offsetMatch = timeOffset.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const offHour = Number(offsetMatch[2]);
    const offMin = Number(offsetMatch[3]);
    if (offHour > 23 || offMin > 59) return false;
  }
  return true;
}

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Characters that are dangerous in shell contexts. */
const SHELL_CHARS = /[;|&$`\\"'<>(){}!#\n\r]/;

/** Input schema for the `publish_podcast` tool. */
export const PublishPodcastInput = z.object({
  outputFilename: z.string(),
  episodeTitle: z.string().min(1).max(250),
  episodeDescription: z.string().min(1).max(5000),
  episodeNumber: z.number().int().positive().optional(),
  episodeSeason: z.number().int().positive().optional(),
  episodeGuid: z.string().optional(),
  episodePublishedAt: z.string().refine(isValidRFC3339, { message: 'must be a valid RFC 3339 datetime' }).optional(),
});

export type PublishPodcastInput = z.infer<typeof PublishPodcastInput>;

/** Configuration for RSS publishing. */
export interface RssConfig {
  feed: FeedBackend;
  feedUrl: string;
  podcast: PodcastMetadata;
  publicUrl: string;
}

/** Configuration for S3 publishing. */
export interface S3PublishConfig {
  bucket: string;
  publicUrl: string;
}

/** Options passed to `createPublishHandler`. */
export interface PublishHandlerOptions {
  storage: StorageBackend;
  feed?: RssConfig;
  s3?: S3PublishConfig;
  outputDir: string;
  publishPublicUrl?: string;
}

/**
 * Create a publish handler function.
 *
 * The returned function takes `PublishPodcastInput` and returns
 * `PublishResult`. It never throws.
 */
export function createPublishHandler(options: PublishHandlerOptions) {
  const { storage, feed, s3, outputDir, publishPublicUrl } = options;

  const hasStorage = !!s3;
  const hasFeed = !!feed;
  const feedBackend = feed?.feed;

  return async function publishPodcast(input: PublishPodcastInput): Promise<PublishResult> {
    try {
      return await executePublish(input, {
        hasStorage,
        hasFeed,
        storage,
        feedBackend,
        feed,
        s3,
        outputDir,
        publishPublicUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[publish_podcast] Unexpected error');
      return {
        success: false,
        errorCode: 'publish_error',
        stages: {
          s3: skipResult('unexpected error'),
          rss: skipResult('unexpected error'),
        },
      };
    }
  };
}

async function executePublish(
  input: PublishPodcastInput,
  opts: {
    hasStorage: boolean;
    hasFeed: boolean;
    storage: StorageBackend;
    feedBackend: FeedBackend | undefined;
    feed: RssConfig | undefined;
    s3: S3PublishConfig | undefined;
    outputDir: string;
    publishPublicUrl: string | undefined;
  }
): Promise<PublishResult> {
  // Short-circuit if no storage or feed configured
  if (!opts.hasStorage && !opts.hasFeed) {
    return buildResult({
      s3: skipResult('S3 not configured'),
      rss: skipResult('RSS not configured'),
      errorCode: 'no_storage_or_feed_configured',
    });
  }

  // Validate filename
  // Reject path traversal / shell metacharacters early (before realpath)
  if (SHELL_CHARS.test(input.outputFilename)) {
    return buildResult({
      s3: skipResult('validation_failed'),
      rss: skipResult('validation_failed'),
      errorCode: 'invalid_output_filename',
    });
  }

  const validationError = validateFilename(input.outputFilename);
  if (validationError) {
    return buildResult({
      s3: skipResult('validation_failed'),
      rss: skipResult('validation_failed'),
      errorCode: 'invalid_output_filename',
    });
  }

  const filename = path.basename(input.outputFilename);
  const candidatePath = path.join(opts.outputDir, filename);

  // realpath containment check — reject if resolved path is outside outputDir
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(candidatePath);
  } catch {
    return buildResult({
      s3: skipResult('file_not_found'),
      rss: skipResult('file_not_found'),
      errorCode: 'file_not_found',
    });
  }

  let resolvedOutputDir: string;
  try {
    resolvedOutputDir = fs.realpathSync(opts.outputDir);
  } catch {
    resolvedOutputDir = path.resolve(opts.outputDir);
  }

  const relative = path.relative(resolvedOutputDir, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return buildResult({
      s3: skipResult('path_traversal_attempted'),
      rss: skipResult('path_traversal_attempted'),
      errorCode: 'path_traversal_attempted',
    });
  }

  // Symlink + type check on the candidate path
  let statResult: fs.Stats;
  try {
    const lstatResult = fs.lstatSync(candidatePath);
    if (lstatResult.isSymbolicLink()) {
      return buildResult({
        s3: skipResult('path_traversal_attempted'),
        rss: skipResult('path_traversal_attempted'),
        errorCode: 'path_traversal_attempted',
      });
    }
    if (!lstatResult.isFile()) {
      return buildResult({
        s3: skipResult('file_not_found'),
        rss: skipResult('file_not_found'),
        errorCode: 'file_not_found',
      });
    }
    // lstat is fine for symlinks, but for the probe stat we use fs.stat
    // on the resolved path to get the canonical file stats.
    statResult = lstatResult;
  } catch {
    return buildResult({
      s3: skipResult('file_not_found'),
      rss: skipResult('file_not_found'),
      errorCode: 'file_not_found',
    });
  }

  // Separate fs.stat probe on the resolved path (per plan spec)
  // Use the canonical stat result for file size (not lstat).
  let probeStatFailed = false;
  let fileSizeBytes: number;
  try {
    const statOnResolved = fs.statSync(resolvedPath);
    fileSizeBytes = statOnResolved.size;
  } catch {
    probeStatFailed = true;
    // Reject before unbounded readFile — we don't know the real file size
    return buildResult({
      s3: skipResult('stat_failed'),
      rss: skipResult('stat_failed'),
      errorCode: 'probe_stat_failed',
      probeStatFailed: true,
    });
  }

  // Size check
  if (fileSizeBytes > 500 * 1024 * 1024) {
    return buildResult({
      s3: skipResult('file_too_large'),
      rss: skipResult('file_too_large'),
      errorCode: 'file_too_large',
    });
  }

  // ffprobe
  let durationSeconds: number | undefined;
  let probeFFprobeFailed = false;
  try {
    durationSeconds = await probeDuration(candidatePath);
  } catch {
    probeFFprobeFailed = true;
  }

  // probeStatFailed is already set above from the fs.stat call

  // Construct episode metadata
  const episode: {
    title: string;
    description: string;
    guid: string;
    publishedAt: string;
    episodeNumber?: number;
    season?: number;
    durationSeconds?: number;
  } = {
    title: input.episodeTitle,
    description: input.episodeDescription,
    guid: input.episodeGuid ?? filename,
    publishedAt: input.episodePublishedAt ?? new Date().toISOString(),
  };
  if (input.episodeNumber !== undefined) episode.episodeNumber = input.episodeNumber;
  if (input.episodeSeason !== undefined) episode.season = input.episodeSeason;
  if (durationSeconds !== undefined) episode.durationSeconds = durationSeconds;

  // S3 upload
  let s3Result: StageResult = skipResult('not configured');
  let mediaAsset: { url: string; lengthBytes: number; mimeType: string } | undefined;
  if (opts.hasStorage) {
    try {
      const s3Key = `episodes/${filename}`;
      mediaAsset = await opts.storage.upload(candidatePath, s3Key);
      s3Result = { status: 'succeeded', s3Url: mediaAsset.url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[publish_podcast] S3 upload failed');
      s3Result = { status: 'failed', errorCode: 's3_upload_failed', errorMessage: message };
    }
  }

  // RSS update
  let rssResult: StageResult = skipResult('not configured');
  if (opts.hasFeed) {
    // Only attempt RSS if we have a valid MediaAsset
    if (!mediaAsset) {
      if (opts.publishPublicUrl) {
        // RSS fallback: construct URL from publishPublicUrl.
        // Reject loopback/localhost hosts — they are unreachable from podcast clients.
        let normalizedUrl = opts.publishPublicUrl.replace(/\/+$/, '');
        let isInvalid = false;
        if (!normalizedUrl) {
          rssResult = { status: 'failed', errorCode: 'rss_missing_media_url', errorMessage: 'publishPublicUrl is empty or only slashes' };
        } else {
          try {
            const parsed = new URL(normalizedUrl);
            // Only allow http/https protocols
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              isInvalid = true;
            } else {
              const h = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
              // Detect full loopback range: localhost, 127.x.x.x, ::1, fe80::, 0.0.0.0
              if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.startsWith('fe80::')) {
                isInvalid = true;
              } else if (/^127\./.test(h)) {
                isInvalid = true;
              }
            }
          } catch {
            isInvalid = true;
          }
          if (isInvalid) {
            rssResult = { status: 'failed', errorCode: 'rss_missing_media_url', errorMessage: 'publishPublicUrl is invalid or a loopback address — required for RSS enclosure URLs' };
          } else {
            const encodedFilename = encodeURIComponent(filename);
            const rssMediaAsset = {
              url: `${normalizedUrl}/output/${encodedFilename}`,
              lengthBytes: fileSizeBytes,
              mimeType: 'audio/mpeg',
            };
            mediaAsset = rssMediaAsset;
          }
        }
      } else {
        // No S3 and no publishPublicUrl — RSS has no valid MediaAsset
        rssResult = { status: 'failed', errorCode: 'rss_missing_media_url', errorMessage: 'No S3 URL and publishPublicUrl not configured' };
      }
    }

    if (mediaAsset && !opts.feedBackend) {
      rssResult = { status: 'failed', errorCode: 'rss_config_missing', errorMessage: 'RSS configured but feed backend missing' };
    } else if (mediaAsset && opts.feedBackend) {
      try {
        const feedResult = await opts.feedBackend.addEpisode(
          opts.feed!.feedUrl,
          episode,
          mediaAsset
        );
        rssResult = { status: 'succeeded', feedUrl: feedResult.feedUrl };
      } catch (err) {
        const feedErr = err as { code?: string; message?: string };
        const errorCode = feedErr.code || 'rss_update_failed';
        const message = feedErr.message || String(err);
        logger.error({ err }, '[publish_podcast] RSS update failed');
        rssResult = { status: 'failed', errorCode, errorMessage: message };
      }
    }
  }

  return buildResult({
    s3: s3Result,
    rss: rssResult,
    fileSizeBytes,
    durationSeconds,
    probeStatFailed,
    probeFFprobeFailed,
  });
}

function validateFilename(filename: string): string | null {
  // Reject null bytes
  if (filename.includes('\0')) {
    return 'invalid_output_filename';
  }
  // Reject path traversal
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return 'invalid_output_filename';
  }
  // Must end in .mp3 or .MP3
  const lower = filename.toLowerCase();
  if (!lower.endsWith('.mp3')) {
    return 'invalid_output_filename';
  }
  return null;
}

function skipResult(reason: string): StageResult {
  return { status: 'skipped', reason };
}

function buildResult(opts: {
  s3: StageResult;
  rss: StageResult;
  errorCode?: string;
  fileSizeBytes?: number;
  durationSeconds?: number;
  probeStatFailed?: boolean;
  probeFFprobeFailed?: boolean;
}): PublishResult {
  const { s3, rss, errorCode, fileSizeBytes, durationSeconds, probeStatFailed, probeFFprobeFailed } = opts;
  const success = s3.status === 'succeeded' || rss.status === 'succeeded';

  // Determine errorCode precedence per spec:
  //   probe error takes precedence over stage errors when no stage succeeded
  //   otherwise first-failure stage error
  let finalErrorCode = errorCode;
  if (!finalErrorCode && !success) {
    // Probe errors take precedence over stage failures
    if (probeFFprobeFailed) {
      finalErrorCode = 'probe_ffprobe_failed';
    } else if (probeStatFailed) {
      finalErrorCode = 'probe_stat_failed';
    } else {
      // No probe errors — first failure stage
      if (s3.status === 'failed') {
        finalErrorCode = (s3 as { errorCode?: string }).errorCode;
      } else if (rss.status === 'failed') {
        finalErrorCode = (rss as { errorCode?: string }).errorCode;
      }
    }
  }

  return {
    success,
    stages: { s3, rss },
    ...(finalErrorCode ? { errorCode: finalErrorCode } : {}),
    ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(probeStatFailed ? { probeStatFailed } : {}),
    ...(probeFFprobeFailed ? { probeFFprobeFailed } : {}),
  };
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_entries', 'format=duration',
      filePath,
    ]);

    let output = '';
    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr.on('data', () => {
      // Ignore stderr
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('ffprobe timeout (30s)'));
    }, 30_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(output);
        const dur = parsed.format?.duration;
        if (dur === undefined || dur === null) {
          reject(new Error('ffprobe: no duration in output'));
          return;
        }
        const num = Number(dur);
        if (!Number.isFinite(num) || num < 0) {
          reject(new Error('ffprobe: invalid duration value'));
          return;
        }
        resolve(num);
      } catch {
        reject(new Error('ffprobe: failed to parse output'));
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      reject(new Error('ffprobe: spawn failed'));
    });
  });
}
