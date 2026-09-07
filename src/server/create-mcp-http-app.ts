import express, { NextFunction, Request, Response, type Express } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface McpHttpLogger {
  info(bindings: Record<string, unknown>, message: string): unknown;
  error(bindings: Record<string, unknown>, message: string): unknown;
}

export interface McpHttpAppOptions {
  /** Factory called for every stateless MCP request. */
  createMcpServer(): McpServer;
  /** Directory exposed at `/output`; omitted when an embedding test does not need it. */
  outputDir?: string;
  /** Defaults to the health response's service version. */
  version?: string;
  logger?: McpHttpLogger;
}

const noopLogger: McpHttpLogger = {
  info(bindings, message) {
    void bindings;
    void message;
  },
  error(bindings, message) {
    void bindings;
    void message;
  },
};

/**
 * Build the production HTTP composition without opening a listening socket.
 * The executable entry point supplies the same factory and options, while
 * integration tests can drive this app over a real Node HTTP server.
 */
export function createMcpHttpApp(options: McpHttpAppOptions): Express {
  const app = express();
  const log = options.logger ?? noopLogger;

  app.use((req, _res, next) => {
    log.info(
      {
        method: req.method,
        path: req.path,
        contentLength: req.headers['content-length'],
      },
      'Incoming request',
    );
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  if (options.outputDir) {
    app.use('/output', express.static(options.outputDir));
  }

  // Catch JSON body parse errors (malformed or oversized payload).
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    const httpErr = err as Error & { type?: string; status?: number };
    if (httpErr.type === 'entity.too.large') {
      log.error({ path: req.path }, 'Request body too large');
      res.status(413).json({ error: 'Request body too large (limit 10mb)' });
      return;
    }
    if (httpErr.type === 'entity.parse.failed') {
      // Do not echo parser details: depending on the parser/runtime they can
      // contain a fragment of the submitted script or another secret.
      log.error({ path: req.path }, 'Invalid JSON body');
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    next(err);
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'mcp-podcast-generator',
      version: options.version ?? '1.0.0',
    });
  });

  // Streamable HTTP is deliberately stateless: a fresh MCP server and
  // transport are created per request, while the injected job manager remains
  // process-scoped in the production composition.
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // The endpoint is stateless and closes its transport after each request;
      // JSON response mode ensures the complete result is written before that
      // close instead of leaving an SSE stream for a request-scoped transport.
      enableJsonResponse: true,
    });

    log.info({ tool: req.body?.params?.name }, 'MCP tool call received');

    try {
      const server = options.createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      void err;
      // Keep transport diagnostics free of request arguments; the operation
      // handlers already return safe, structured errors to the caller.
      log.error({ errorCode: 'mcp_transport_error' }, 'MCP transport error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP transport error' });
      }
    } finally {
      await transport.close().catch((err: unknown) => {
        void err;
        log.error({ errorCode: 'mcp_transport_close_error' }, 'MCP transport close error');
      });
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'MCP endpoint requires POST with JSON-RPC body. See README for usage.',
    });
  });

  return app;
}
