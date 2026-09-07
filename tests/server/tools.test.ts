import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createJobManager } from '../../src/jobs/index.js';
import type { JobManager } from '../../src/jobs/job-types.js';
import {
  createMcpServer,
  parseExposeSeparateTools,
  type AsyncJobLogger,
  type McpServerDependencies,
} from '../../src/server/create-mcp-server.js';
import { createMcpHttpApp } from '../../src/server/create-mcp-http-app.js';
import type { GeneratePodcastOutput } from '../../src/tools/generate-podcast.js';
import type { PublishResult } from '../../src/feed/feed-types.js';

const generationInput = {
  type: 'single' as const,
  hosts: [{ name: 'Alex', voice: 'Charon' }],
  segments: [{ text: 'A safe test script.' }],
  outputFilename: 'episode-test.mp3',
  fadeInDuration: 2,
  fadeOutDuration: 3,
  targetLufs: -16,
  episodeTitle: 'Episode one',
  episodeDescription: 'A test episode.',
};

const generationOutput: GeneratePodcastOutput = {
  success: true,
  outputPath: '/output/episode-test.mp3',
  durationSeconds: 12,
};

const publishResult: PublishResult = {
  success: true,
  fileSizeBytes: 1234,
  durationSeconds: 12,
  stages: {
    s3: { status: 'succeeded', s3Url: 'https://podcasts.example.test/episode-test.mp3' },
    rss: { status: 'skipped', reason: 'not configured' },
  },
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeLogger() {
  const entries: Array<{ level: string; bindings: Record<string, unknown>; message: string }> = [];
  const logger: AsyncJobLogger = {
    info(bindings, message) {
      entries.push({ level: 'info', bindings, message });
    },
    error(bindings, message) {
      entries.push({ level: 'error', bindings, message });
    },
  };
  return { logger, entries };
}

function makeDependencies(
  manager: JobManager,
  overrides: Partial<McpServerDependencies> = {},
): McpServerDependencies {
  return {
    jobManager: manager,
    publicUrl: 'https://podcasts.example.test',
    generate: vi.fn().mockResolvedValue(generationOutput),
    publish: vi.fn().mockResolvedValue(publishResult),
    ...overrides,
  };
}

async function connectPair(dependencies: McpServerDependencies) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-client', version: '1.0.0' });
  const server = createMcpServer(dependencies);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function closePair(client: Client, server: ReturnType<typeof createMcpServer>) {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
}

function contentJson(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Expected a text content block');
  return JSON.parse(text.text) as Record<string, unknown>;
}

function inputForOperation() {
  return {
    type: generationInput.type,
    hosts: generationInput.hosts,
    segments: generationInput.segments,
    outputFilename: generationInput.outputFilename,
    fadeInDuration: generationInput.fadeInDuration,
    fadeOutDuration: generationInput.fadeOutDuration,
    targetLufs: generationInput.targetLufs,
    episodeTitle: generationInput.episodeTitle,
    episodeDescription: generationInput.episodeDescription,
  };
}

describe('MCP async tool registration', () => {
  const openPairs: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

  afterEach(async () => {
    while (openPairs.length > 0) {
      const pair = openPairs.pop()!;
      await closePair(pair.client, pair.server);
    }
  });

  it('parses EXPOSE_SEPARATE_TOOLS strictly and snapshots the visibility choice', async () => {
    expect(parseExposeSeparateTools(undefined)).toBe(false);
    expect(parseExposeSeparateTools('')).toBe(false);
    expect(parseExposeSeparateTools('TRUE')).toBe(false);
    expect(parseExposeSeparateTools('true ')).toBe(false);
    expect(parseExposeSeparateTools('true')).toBe(true);

    const manager = createJobManager();
    const defaults = await connectPair(makeDependencies(manager, { exposeSeparateTools: false }));
    openPairs.push(defaults);
    expect((await defaults.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'generate_and_publish',
      'get_job_status',
    ]);

    const optIn = await connectPair(makeDependencies(manager, { exposeSeparateTools: true }));
    openPairs.push(optIn);
    expect((await optIn.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'generate_and_publish',
      'generate_podcast',
      'get_job_status',
      'publish_podcast',
    ]);
  });

  it('accepts all three operation tools immediately while their cores remain deferred', async () => {
    const manager = createJobManager();
    const generationGate = deferred<GeneratePodcastOutput>();
    const publishGate = deferred<PublishResult>();
    const generate = vi.fn().mockReturnValue(generationGate.promise);
    const publish = vi.fn().mockReturnValue(publishGate.promise);
    const pair = await connectPair(
      makeDependencies(manager, {
        exposeSeparateTools: true,
        generate,
        publish,
      }),
    );
    openPairs.push(pair);

    const generateAccepted = contentJson(
      await pair.client.callTool({
        name: 'generate_podcast',
        arguments: {
          type: generationInput.type,
          hosts: generationInput.hosts,
          segments: generationInput.segments,
          outputFilename: generationInput.outputFilename,
        },
      }),
    );
    const publishAccepted = contentJson(
      await pair.client.callTool({
        name: 'publish_podcast',
        arguments: {
          outputFilename: generationInput.outputFilename,
          episodeTitle: generationInput.episodeTitle,
          episodeDescription: generationInput.episodeDescription,
        },
      }),
    );

    expect(generateAccepted).toMatchObject({
      operation: 'generate_podcast',
      status: 'queued',
      stage: 'queued',
    });
    expect(publishAccepted).toMatchObject({
      operation: 'publish_podcast',
      status: 'queued',
      stage: 'queued',
    });
    expect(generateAccepted.jobId).not.toBe(publishAccepted.jobId);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();

    generationGate.resolve(generationOutput);
    await flush();
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    publishGate.resolve(publishResult);
    await flush();
    await flush();
  });

  it('exposes separate publishing without a backend and preserves the stable failure code', async () => {
    const manager = createJobManager();
    const publish = vi.fn().mockResolvedValue({
      success: false,
      errorCode: 'no_storage_or_feed_configured',
      stages: {
        s3: { status: 'skipped', reason: 'S3 not configured' },
        rss: { status: 'skipped', reason: 'RSS not configured' },
      },
    } satisfies PublishResult);
    const pair = await connectPair(
      makeDependencies(manager, { exposeSeparateTools: true, publish }),
    );
    openPairs.push(pair);

    const accepted = contentJson(
      await pair.client.callTool({
        name: 'publish_podcast',
        arguments: {
          outputFilename: 'episode-test.mp3',
          episodeTitle: 'Episode one',
          episodeDescription: 'A test episode.',
        },
      }),
    );
    await flush();
    const status = contentJson(
      await pair.client.callTool({
        name: 'get_job_status',
        arguments: { jobId: accepted.jobId },
      }),
    );
    expect(status).toMatchObject({
      status: 'failed',
      error: { code: 'no_storage_or_feed_configured' },
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('returns accepted immediately, runs once, and polls through a separate server instance', async () => {
    const manager = createJobManager();
    const gate = deferred<GeneratePodcastOutput>();
    const generate = vi.fn().mockReturnValue(gate.promise);
    const publish = vi.fn().mockResolvedValue(publishResult);
    const first = await connectPair(makeDependencies(manager, { generate, publish }));
    openPairs.push(first);

    const acceptedResult = await first.client.callTool({
      name: 'generate_and_publish',
      arguments: inputForOperation(),
    });
    const accepted = contentJson(acceptedResult);
    expect(accepted.status).toBe('queued');
    expect(accepted.stage).toBe('queued');
    expect(accepted.operation).toBe('generate_and_publish');
    expect(String(accepted.jobId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(String(accepted.message)).toMatch(/poll get_job_status/i);
    expect(String(accepted.message)).toMatch(/do not resubmit/i);
    expect(acceptedResult.structuredContent).toEqual(accepted);
    // The UUID is returned while this deferred core is still unresolved; the
    // invocation itself may already have started in the process worker.
    expect(generate).toHaveBeenCalledTimes(1);

    // A new stateless MCP server instance can observe the same process queue.
    const second = await connectPair(makeDependencies(manager, { generate, publish }));
    openPairs.push(second);
    await flush();
    const runningResult = await second.client.callTool({
      name: 'get_job_status',
      arguments: { jobId: accepted.jobId },
    });
    const running = contentJson(runningResult);
    expect(running.status).toBe('running');
    expect(running.stage).toBe('generating');
    expect(generate).toHaveBeenCalledTimes(1);

    gate.resolve(generationOutput);
    await flush();
    await flush();
    const terminalResult = await second.client.callTool({
      name: 'get_job_status',
      arguments: { jobId: accepted.jobId },
    });
    const terminal = contentJson(terminalResult);
    expect(terminal.status).toBe('succeeded');
    expect(terminal.stage).toBe('completed');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ outputFilename: 'episode-test.mp3' }),
      expect.any(Function),
    );

    const repeated = contentJson(
      await second.client.callTool({
        name: 'get_job_status',
        arguments: { jobId: accepted.jobId },
      }),
    );
    expect(repeated).toEqual(terminal);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue malformed operations and returns job_not_found for unknown IDs', async () => {
    const manager = createJobManager();
    const submit = vi.spyOn(manager, 'submit');
    const generate = vi.fn().mockResolvedValue(generationOutput);
    const pair = await connectPair(makeDependencies(manager, { generate }));
    openPairs.push(pair);

    const malformed = await pair.client.callTool({
      name: 'get_job_status',
      arguments: { jobId: 'not-a-uuid' },
    });
    expect(malformed.isError).toBe(true);
    expect(malformed.content.some((block) => block.type === 'text' && /MCP error/i.test(block.text))).toBe(true);

    const invalidOperation = await pair.client.callTool({
      name: 'generate_and_publish',
      arguments: { ...inputForOperation(), outputFilename: '' },
    });
    expect(invalidOperation.isError).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    const unknown = await pair.client.callTool({
      name: 'get_job_status',
      arguments: { jobId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknown.isError).toBe(true);
    expect(contentJson(unknown)).toEqual({
      errorCode: 'job_not_found',
      message: 'Job not found',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps independent IDs isolated and logs only safe lifecycle fields', async () => {
    const manager = createJobManager();
    const firstGate = deferred<GeneratePodcastOutput>();
    const secondGate = deferred<GeneratePodcastOutput>();
    const generate = vi
      .fn()
      .mockReturnValueOnce(firstGate.promise)
      .mockReturnValueOnce(secondGate.promise);
    const { logger, entries } = makeLogger();
    const pair = await connectPair(makeDependencies(manager, { generate, logger }));
    openPairs.push(pair);

    const first = contentJson(
      await pair.client.callTool({ name: 'generate_and_publish', arguments: inputForOperation() }),
    );
    const second = contentJson(
      await pair.client.callTool({
        name: 'generate_and_publish',
        arguments: { ...inputForOperation(), outputFilename: 'episode-two.mp3' },
      }),
    );
    expect(first.jobId).not.toBe(second.jobId);

    const queuedSecond = contentJson(
      await pair.client.callTool({ name: 'get_job_status', arguments: { jobId: second.jobId } }),
    );
    expect(queuedSecond).toMatchObject({ status: 'queued', stage: 'queued' });

    firstGate.resolve(generationOutput);
    await flush();
    await flush();
    const firstStatus = contentJson(
      await pair.client.callTool({ name: 'get_job_status', arguments: { jobId: first.jobId } }),
    );
    expect(firstStatus.status).toBe('succeeded');
    expect(secondStatus(manager, String(second.jobId))).toMatchObject({
      status: 'running',
      stage: 'generating',
    });
    secondGate.resolve(generationOutput);
    await flush();
    await flush();
    expect(generate).toHaveBeenCalledTimes(2);
    const ids = entries
      .map((entry) => entry.bindings.jobId)
      .filter((jobId): jobId is string => typeof jobId === 'string');
    expect(new Set(ids)).toEqual(new Set([first.jobId, second.jobId]));
    expect(JSON.stringify(entries)).not.toContain('A safe test script.');
  });
});

function secondStatus(manager: JobManager, jobId: string) {
  return manager.get(jobId);
}

async function httpJson(
  app: ReturnType<typeof createMcpHttpApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server: HttpServer = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const initializeRequest = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'http-integration-client', version: '1.0.0' },
  },
});

describe('production Streamable HTTP composition', () => {
  it('survives transport closure and polls an accepted job through a later HTTP request', async () => {
    const manager = createJobManager();
    const gate = deferred<GeneratePodcastOutput>();
    const generate = vi.fn().mockReturnValue(gate.promise);
    const dependencies = makeDependencies(manager, { generate });
    const app = createMcpHttpApp({
      createMcpServer: () => createMcpServer(dependencies),
      logger: makeLogger().logger,
    });

    const initialized = await httpJson(app, initializeRequest(1));
    expect(initialized.status).toBe(200);
    expect(initialized.body).toHaveProperty('result');

    const listed = await httpJson(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    expect(listed.status).toBe(200);
    const listedNames = ((listed.body.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );
    expect(listedNames).toEqual(['generate_and_publish', 'get_job_status']);

    const accepted = await httpJson(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'generate_and_publish', arguments: inputForOperation() },
    });
    expect(accepted.status).toBe(200);
    const acceptedResult = accepted.body.result as { structuredContent: Record<string, unknown> };
    const jobId = acceptedResult.structuredContent.jobId;
    expect(String(jobId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generate).toHaveBeenCalledTimes(1);

    await flush();
    const status = await httpJson(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_job_status', arguments: { jobId } },
    });
    expect(status.status).toBe(200);
    expect((status.body.result as { structuredContent: Record<string, unknown> }).structuredContent).toMatchObject({
      jobId,
      status: 'running',
      stage: 'generating',
    });

    gate.resolve(generationOutput);
    await flush();
    await flush();
    const terminal = await httpJson(app, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_job_status', arguments: { jobId } },
    });
    expect((terminal.body.result as { structuredContent: Record<string, unknown> }).structuredContent).toMatchObject({
      jobId,
      status: 'succeeded',
      stage: 'completed',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
