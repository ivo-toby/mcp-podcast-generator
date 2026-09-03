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
  episodePublishedAt: z.string().regex(RFC3339_REGEX, { message: 'must be RFC 3339' }).optional(),
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
      s3: skipResult('no_storage_configured'),
      rss: skipResult('no_feed_configured'),
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

  // Stat + symlink check on the candidate path
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
    statResult = lstatResult;
  } catch {
    return buildResult({
      s3: skipResult('file_not_found'),
      rss: skipResult('file_not_found'),
      errorCode: 'file_not_found',
    });
  }

  const fileSizeBytes = statResult.size;

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

  // Stat is always available at this point
  const probeStatFailed = false;

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
  let s3Result: StageResult = skipResult('not_configured');
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
  let rssResult: StageResult = skipResult('not_configured');
  if (opts.hasFeed) {
    // Only attempt RSS if we have a valid MediaAsset
    if (!mediaAsset) {
      if (opts.publishPublicUrl) {
        // RSS-only fallback: construct URL from publishPublicUrl
        const normalizedUrl = opts.publishPublicUrl.replace(/\/+$/, '');
        if (!normalizedUrl) {
          rssResult = { status: 'failed', errorCode: 'rss_missing_media_url', errorMessage: 'publishPublicUrl is empty or only slashes' };
        } else {
          const encodedFilename = encodeURIComponent(filename);
          const rssMediaAsset = {
            url: `${normalizedUrl}/output/${encodedFilename}`,
            lengthBytes: fileSizeBytes,
            mimeType: 'audio/mpeg',
          };
          mediaAsset = rssMediaAsset;
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
        resolve(Number(dur));
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
