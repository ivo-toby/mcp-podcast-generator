import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mkdir } from 'fs/promises';
import { generatePodcast, GeneratePodcastInput } from './tools/generate-podcast.js';
import { logger } from './utils/logger.js';

// Configuration from environment
const config = {
  googleApiKey: process.env.GOOGLE_API_KEY ?? '',
  outputDir: process.env.OUTPUT_DIR ?? '/output',
  tempDir: process.env.TEMP_DIR ?? '/tmp/podcast-gen',
  port: parseInt(process.env.PORT ?? '3000', 10),
};

if (!config.googleApiKey) {
  logger.fatal('GOOGLE_API_KEY environment variable is required');
  process.exit(1);
}

// Ensure output and temp dirs exist
await mkdir(config.outputDir, { recursive: true });
await mkdir(config.tempDir, { recursive: true });

// Factory: create a fresh McpServer per request (stateless mode requires this)
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'podcast-generator',
    version: '1.0.0',
  });

  server.tool(
    'generate_podcast',
    'Generate a podcast MP3 from a script using Google Gemini TTS. Supports single-host monologue and dual-host dialogue formats. Optionally adds intro/outro music from URLs and applies EBU R128 loudness normalization.',
    GeneratePodcastInput.shape,
    async (input) => {
      try {
        const validated = GeneratePodcastInput.parse(input);
        const result = await generatePodcast(validated, config);

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
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-podcast-generator', version: '1.0.0' });
});

// MCP endpoint (Streamable HTTP transport — one server instance per request)
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  logger.debug({ method: req.body?.method }, 'MCP request received');

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
    { port: config.port, outputDir: config.outputDir },
    'MCP Podcast Generator started'
  );
});
