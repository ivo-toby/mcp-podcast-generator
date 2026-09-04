import express, { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mkdir } from 'fs/promises';
import { generatePodcast, GeneratePodcastInput } from './tools/generate-podcast.js';
import { logger } from './utils/logger.js';
import { validateS3Config, type S3Config } from './storage/storage-types.js';
import { S3StorageBackend } from './storage/s3-storage.js';
import { deriveFeedKey } from './utils/feed-utils.js';
import { RssFeedBackend } from './feed/rss-feed.js';
import {
  createPublishHandler,
  PublishPodcastInput,
  type RssConfig,
  type S3PublishConfig,
} from './tools/publish-podcast.js';

// Configuration from environment
const config = {
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  outputDir: process.env.OUTPUT_DIR ?? '/output',
  tempDir: process.env.TEMP_DIR ?? '/tmp/podcast-gen',
  port: parseInt(process.env.PORT ?? '3000', 10),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`).replace(/\/$/, ''),
  // Raw PUBLIC_URL (no localhost default) — used by publish_podcast RSS fallback
  rawPublicUrl: process.env.PUBLIC_URL,
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
  // Validate required podcast metadata
  const missing = [
    !podcastTitle && 'PODCAST_TITLE',
    !podcastDescription && 'PODCAST_DESCRIPTION',
    !podcastLink && 'PODCAST_LINK',
    !podcastAuthor && 'PODCAST_AUTHOR',
  ].filter(Boolean);

  if (missing.length > 0) {
    logger.fatal(
      `RSS configured (RSS_FEED_URL set) but missing required metadata: ${missing.join(', ')}`
    );
    process.exit(1);
  }

  // RSS-only mode (no S3) requires PUBLIC_URL
  const hasS3 = s3Config !== null;
  if (!hasS3) {
    const pubUrl = config.publicUrl;
    if (!pubUrl) {
      logger.fatal(
        'RSS-only mode requires PUBLIC_URL (no S3 configured and no PUBLIC_URL set)'
      );
      process.exit(1);
    }
    // Reject loopback/localhost hosts and non-HTTP(S) protocols
    try {
      const parsed = new URL(pubUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        logger.fatal(
          `PUBLIC_URL "${pubUrl}" uses unsupported protocol "${parsed.protocol}" — required for RSS-only enclosure URLs.`
        );
        process.exit(1);
      }
      const h = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
      const badHosts = ['localhost', '::1', '0.0.0.0'];
      if (badHosts.includes(h) || /^127\./.test(h) || h.startsWith('fe80::')) {
        logger.fatal(
          `PUBLIC_URL hostname "${parsed.hostname}" is a private/loopback address — required for RSS-only enclosure URLs. Use a public hostname.`
        );
        process.exit(1);
      }
    } catch {
      // Invalid URL — fatal, cannot construct enclosure URLs
      logger.fatal(
        `PUBLIC_URL "${pubUrl}" is not a valid URL — required for RSS-only enclosure URLs.`
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
    throw new Error(
      'RSS feed URL is malformed — cannot derive S3 key from feed URL'
    );
  }

  // Derive feed key from URL path (root path maps to podcast.xml)
  const feedKey = deriveFeedKey(rssFeedUrl, s3Config);
  if (s3Config && !feedKey) {
    throw new Error(
      'RSS feed URL does not match S3_PUBLIC_URL origin — feed must be stored inside the S3 bucket'
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
    feedKey
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

// Ensure output and temp dirs exist
try {
  await mkdir(config.outputDir, { recursive: true });
  await mkdir(config.tempDir, { recursive: true });
} catch (err) {
  logger.fatal({ err, outputDir: config.outputDir, tempDir: config.tempDir }, 'Failed to create required directories');
  process.exit(1);
}

// Factory: create a fresh McpServer per request (stateless mode requires this)
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'podcast-generator',
    version: '1.0.0',
  });

  // Register publish_podcast tool
  if (storageBackend || rssConfig) {
    const publishHandler = createPublishHandler({
      storage: storageBackend!,
      feed: rssConfig ?? undefined,
      s3: s3Config
        ? { bucket: s3Config.bucket, publicUrl: s3Config.publicUrl }
        : undefined,
      outputDir: config.outputDir,
      // Pass raw PUBLIC_URL (no localhost default) so RSS fallback
      // never produces localhost enclosure URLs.
      publishPublicUrl: config.rawPublicUrl,
    });

    server.tool(
      'publish_podcast',
      'Publish a generated podcast MP3 to S3 storage and/or update the RSS feed. Validates the output file (size, symlinks, traversal), probes duration with ffprobe, uploads to S3 if configured, and/or appends an episode entry to the RSS feed. Returns structured publish results with per-stage status.',
      PublishPodcastInput.shape,
      async (input) => {
        try {
          const validated = PublishPodcastInput.parse(input);
          const result = await publishHandler(validated);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err }, '[publish_podcast] Tool error');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: message }, null, 2),
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  server.tool(
    'generate_podcast',
    'Generate a podcast MP3 from a script using Google Gemini TTS. Supports single-host monologue and dual-host dialogue formats. Optionally adds intro/outro music from URLs and applies EBU R128 loudness normalization. IMPORTANT: This tool takes a long time to run (typically 2-10 minutes depending on script length) because it synthesizes speech for every segment and assembles the final audio. Do NOT assume it has timed out — wait for the response to complete.',
    GeneratePodcastInput.shape,
    async (input) => {
      try {
        const validated = GeneratePodcastInput.parse(input);
        const result = await generatePodcast(validated, config);
        const downloadUrl = `${config.publicUrl}/output/${validated.outputFilename}`;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...result, downloadUrl }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err }, '[generate_podcast] Tool error');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// Create Express app
const app = express();

// Log every incoming request before body parsing so we always see it
app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path, contentLength: req.headers['content-length'] }, 'Incoming request');
  next();
});

app.use(express.json({ limit: '10mb' }));

// Serve generated MP3s so agents and users can download them directly
app.use('/output', express.static(config.outputDir));

// Catch JSON body parse errors (malformed or oversized payload)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  const httpErr = err as Error & { type?: string; status?: number };
  if (httpErr.type === 'entity.too.large') {
    logger.error({ path: req.path }, 'Request body too large');
    res.status(413).json({ error: 'Request body too large (limit: 10mb)' });
    return;
  }
  if (httpErr.type === 'entity.parse.failed') {
    logger.error({ path: req.path, detail: err.message }, 'Invalid JSON body');
    res.status(400).json({ error: 'Invalid JSON body', detail: err.message });
    return;
  }
  next(err);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-podcast-generator', version: '1.0.0' });
});

// MCP endpoint (Streamable HTTP transport — one server instance per request)
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  logger.info({ tool: req.body?.params?.name }, 'MCP tool call received');

  try {
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'MCP transport error');
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  } finally {
    await transport.close();
  }
});

// GET /mcp — return 405 with helpful message
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    error: 'Method Not Allowed',
    message: 'MCP endpoint requires POST with JSON-RPC body. See README for usage.',
  });
});

app.listen(config.port, () => {
  logger.info(
    { port: config.port, outputDir: config.outputDir, publicUrl: config.publicUrl },
    'MCP Podcast Generator started'
  );
});
