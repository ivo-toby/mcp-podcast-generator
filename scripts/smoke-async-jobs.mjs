import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMcpHttpApp } from '../dist/server/create-mcp-http-app.js';
import { createMcpServer } from '../dist/server/create-mcp-server.js';
import { createJobManager } from '../dist/jobs/index.js';

const SMOKE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 10;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(label, predicate, timeoutMs = SMOKE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function toolPayload(responseBody) {
  const result = responseBody?.result;
  assert.ok(result, 'MCP response must contain result');
  assert.ok(result.structuredContent, 'MCP result must contain structuredContent');
  const textBlock = result.content?.find((block) => block.type === 'text');
  assert.ok(textBlock, 'MCP result must contain a text block');
  assert.deepEqual(JSON.parse(textBlock.text), result.structuredContent);
  return result.structuredContent;
}

async function main() {
  const manager = createJobManager();
  const generationGate = deferred();
  let generationCalls = 0;
  let publishCalls = 0;
  let gateSettled = false;

  const generated = {
    success: true,
    outputPath: '/output/smoke.mp3',
    durationSeconds: 3,
  };
  const published = {
    success: true,
    fileSizeBytes: 42,
    durationSeconds: 3,
    stages: {
      s3: { status: 'succeeded', s3Url: 'https://cdn.example.test/smoke.mp3' },
      rss: { status: 'skipped', reason: 'not configured' },
    },
  };

  const dependencies = {
    jobManager: manager,
    publicUrl: 'https://podcasts.example.test',
    generate: async () => {
      generationCalls += 1;
      const result = await generationGate.promise;
      gateSettled = true;
      return result;
    },
    publish: async () => {
      publishCalls += 1;
      return published;
    },
  };

  const app = createMcpHttpApp({
    createMcpServer: () => createMcpServer(dependencies),
  });
  const httpServer = createServer(app);

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object', 'Smoke listener must have an address');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  async function request(id, method, params = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    });
    assert.equal(response.status, 200, `${method} should return HTTP 200`);
    return response.json();
  }

  try {
    const listed = await request(1, 'tools/list');
    const names = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['generate_and_publish', 'get_job_status']);

    const accepted = toolPayload(
      await request(2, 'tools/call', {
        name: 'generate_and_publish',
        arguments: {
          type: 'single',
          hosts: [{ name: 'Alex', voice: 'Charon' }],
          segments: [{ text: 'Compiled smoke fixture.' }],
          outputFilename: 'smoke.mp3',
          episodeTitle: 'Smoke episode',
          episodeDescription: 'Compiled async smoke test.',
        },
      }),
    );
    assert.equal(accepted.status, 'queued');
    assert.equal(accepted.stage, 'queued');
    assert.match(accepted.message, /poll get_job_status/i);
    assert.match(accepted.message, /do not resubmit/i);
    assert.match(accepted.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(gateSettled, false, 'Accepted response must precede gate resolution');
    assert.equal(generationCalls, 1);

    await tick();
    const running = toolPayload(
      await request(3, 'tools/call', {
        name: 'get_job_status',
        arguments: { jobId: accepted.jobId },
      }),
    );
    assert.deepEqual(
      { status: running.status, stage: running.stage },
      { status: 'running', stage: 'generating' },
    );

    generationGate.resolve(generated);
    const terminal = await waitFor('terminal async job', async () => {
      const current = toolPayload(
        await request(4, 'tools/call', {
          name: 'get_job_status',
          arguments: { jobId: accepted.jobId },
        }),
      );
      return current.status === 'succeeded' ? current : false;
    });
    assert.equal(publishCalls, 1);
    assert.equal(terminal.result.downloadUrl, 'https://podcasts.example.test/output/smoke.mp3');
    assert.equal(terminal.result.publish.success, true);

    const repeated = toolPayload(
      await request(5, 'tools/call', {
        name: 'get_job_status',
        arguments: { jobId: accepted.jobId },
      }),
    );
    assert.deepEqual(repeated, terminal);
    assert.equal(generationCalls, 1);
    assert.equal(publishCalls, 1);
  } finally {
    if (!gateSettled) generationGate.resolve(generated);
    await new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
