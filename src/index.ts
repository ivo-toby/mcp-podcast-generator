import { mkdir } from 'fs/promises';
import { logger } from './utils/logger.js';
import { validateS3Config, type S3Config } from './storage/storage-types.js';
import { S3StorageBackend } from './storage/s3-storage.js';
import { deriveFeedKey } from './utils/feed-utils.js';
import { RssFeedBackend } from './feed/rss-feed.js';
import {
  createPublishHandler,
  type RssConfig,
} from './tools/publish-podcast.js';
import { generatePodcast } from './tools/generate-podcast.js';
import {
  createMcpServer as createRegisteredMcpServer,
  parseExposeSeparateTools,
  processJobManager,
} from './server/create-mcp-server.js';
import { createMcpHttpApp } from './server/create-mcp-http-app.js';

// Configuration from environment. Visibility is intentionally parsed once at
// startup; changing EXPOSE_SEPARATE_TOOLS requires a process restart.
const config = {
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  outputDir: process.env.OUTPUT_DIR ?? '/output',
  tempDir: process.env.TEMP_DIR ?? '/tmp/podcast-gen',
  port: parseInt(process.env.PORT ?? '3000', 10),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`).replace(/\/$/, ''),
  // Raw PUBLIC_URL (no localhost default) — used by publish_podcast RSS fallback.
  rawPublicUrl: process.env.PUBLIC_URL,
  exposeSeparateTools: parseExposeSeparateTools(process.env.EXPOSE_SEPARATE_TOOLS),
};

// --- S3 configuration ---
let s3Config: S3Config | null = null;
try {
  const s3Result = validateS3Config();
  s3Config = s3Result.config;
  if (s3Result.enabled && s3Config) {
    logger.info({ bucket: s3Config.bucket }, 'S3 storage enabled');
  }
} catch (err) {
  logger.fatal({ err }, 'S3 configuration invalid — exiting');
  process.exit(1);
}

// --- RSS / feed configuration ---
let rssFeedBackend: RssFeedBackend | null = null;
let rssConfig: RssConfig | null = null;
let storageBackend: S3StorageBackend | null = null;
const rssFeedUrl = process.env.RSS_FEED_URL;
const podcastTitle = process.env.PODCAST_TITLE;
const podcastDescription = process.env.PODCAST_DESCRIPTION;
const podcastLink = process.env.PODCAST_LINK;
const podcastAuthor = process.env.PODCAST_AUTHOR;
const podcastLanguage = process.env.PODCAST_LANGUAGE ?? 'en-us';
const podcastCategories = process.env.PODCAST_CATEGORIES
  ? process.env.PODCAST_CATEGORIES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['Technology'];

// --- S3 storage backend (independent of RSS) ---
if (s3Config) {
  storageBackend = new S3StorageBackend(s3Config);
  logger.info({ bucket: s3Config.bucket }, 'S3 storage backend created');
}

if (rssFeedUrl) {
  // Validate required podcast metadata.
  const missing = [
    !podcastTitle && 'PODCAST_TITLE',
    !podcastDescription && 'PODCAST_DESCRIPTION',
    !podcastLink && 'PODCAST_LINK',
    !podcastAuthor && 'PODCAST_AUTHOR',
  ].filter(Boolean);

  if (missing.length > 0) {
    logger.fatal(
      `RSS configured (RSS_FEED_URL set) but missing required metadata: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  // RSS-only mode (no S3) requires PUBLIC_URL.
  const hasS3 = s3Config !== null;
  if (!hasS3) {
    const pubUrl = config.publicUrl;
    if (!pubUrl) {
      logger.fatal(
        'RSS-only mode requires PUBLIC_URL (no S3 configured and no PUBLIC_URL set)',
      );
      process.exit(1);
    }
    // Reject loopback/localhost hosts and non-HTTP(S) protocols.
    try {
      const parsed = new URL(pubUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        logger.fatal(
          `PUBLIC_URL "${pubUrl}" uses unsupported protocol "${parsed.protocol}" — required for RSS-only enclosure URLs.`,
        );
        process.exit(1);
      }
      const h = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
      const badHosts = ['localhost', '::1', '0.0.0.0'];
      if (badHosts.includes(h) || /^127\./.test(h) || h.startsWith('fe80::')) {
        logger.fatal(
          `PUBLIC_URL hostname "${parsed.hostname}" is a private/loopback address — required for RSS-only enclosure URLs. Use a public hostname.`,
        );
        process.exit(1);
      }
    } catch {
      logger.fatal(
        `PUBLIC_URL "${pubUrl}" is not a valid URL — required for RSS-only enclosure URLs.`,
      );
      process.exit(1);
    }
  }

  // Validate the feed URL before deriving its S3 key. `deriveFeedKey` uses
  // `podcast.xml` for a valid root path, so that key cannot also represent an
  // invalid URL.
  try {
    const parsed = new URL(rssFeedUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('RSS feed URL is malformed — cannot derive S3 key from feed URL');
  }

  // Derive feed key from URL path (root path maps to podcast.xml).
  const feedKey = deriveFeedKey(rssFeedUrl, s3Config);
  if (s3Config && !feedKey) {
    throw new Error(
      'RSS feed URL does not match S3_PUBLIC_URL origin — feed must be stored inside the S3 bucket',
    );
  }

  rssFeedBackend = new RssFeedBackend(
    {
      title: podcastTitle!,
      link: podcastLink!,
      description: podcastDescription!,
      author: podcastAuthor!,
      language: podcastLanguage,
      categories: podcastCategories,
    },
    storageBackend,
    rssFeedUrl,
    feedKey,
  );
  rssConfig = {
    feed: rssFeedBackend,
    feedUrl: rssFeedUrl,
    podcast: {
      title: podcastTitle!,
      link: podcastLink!,
      description: podcastDescription!,
      author: podcastAuthor!,
      language: podcastLanguage,
      categories: podcastCategories,
    },
    publicUrl: config.publicUrl,
  };
  logger.info({ feedUrl: rssFeedUrl, feedKey }, 'RSS feed enabled');
}

if (!config.googleApiKey) {
  logger.fatal('GOOGLE_API_KEY environment variable is required');
  process.exit(1);
}

// Ensure output and temp dirs exist.
try {
  await mkdir(config.outputDir, { recursive: true });
  await mkdir(config.tempDir, { recursive: true });
} catch (err) {
  logger.fatal(
    { err, outputDir: config.outputDir, tempDir: config.tempDir },
    'Failed to create required directories',
  );
  process.exit(1);
}

// Always construct the publish core. With no destination configured it
// returns no_storage_or_feed_configured, which is required when the separate
// publish tool is explicitly exposed.
const publishHandler = createPublishHandler({
  storage: storageBackend!,
  feed: rssConfig ?? undefined,
  s3: s3Config
    ? { bucket: s3Config.bucket, publicUrl: s3Config.publicUrl }
    : undefined,
  outputDir: config.outputDir,
  // Pass raw PUBLIC_URL (no localhost default) so RSS fallback never produces
  // localhost enclosure URLs.
  publishPublicUrl: config.rawPublicUrl,
});

// Fresh MCP server per stateless request, with one process-scoped manager.
function createMcpServer() {
  return createRegisteredMcpServer({
    jobManager: processJobManager,
    exposeSeparateTools: config.exposeSeparateTools,
    publicUrl: config.publicUrl,
    generate: (input) => generatePodcast(input, config),
    publish: publishHandler,
    logger,
  });
}

const app = createMcpHttpApp({
  createMcpServer,
  outputDir: config.outputDir,
  version: '1.0.0',
  logger,
});

app.listen(config.port, () => {
  logger.info(
    { port: config.port, outputDir: config.outputDir, publicUrl: config.publicUrl },
    'MCP Podcast Generator started',
  );
});
