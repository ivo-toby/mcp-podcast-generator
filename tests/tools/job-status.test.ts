import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JobManager, JobStatus, JobExecutionResult } from '../../src/jobs/job-types.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { JobStatusInput, createJobStatusHandler } from '../../src/tools/job-status.js';
import { toMcpToolResult } from '../../src/tools/async-job-response.js';
import { createJobManager } from '../../src/jobs/index.js';

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

function makeJobManager(nowValue: number): JobManager {
  const store = new JobStore(() => nowValue, 86_400_000);
  return {
    submit(_operation, _executor) {
      const jobId = randomUUID();
      store.create(jobId, 'generate_podcast', nowValue);
      return {
        jobId,
        operation: 'generate_podcast',
        status: 'queued',
        stage: 'queued',
        pollIntervalSeconds: 5,
        message: 'Job accepted.',
      };
    },
    get(jobId: string): JobStatus | undefined {
      return store.get(jobId);
    },
  };
}

describe('JobStatusInput schema', () => {
  it('accepts a valid UUID', () => {
    const valid = randomUUID();
    const result = JobStatusInput.safeParse({ jobId: valid });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.jobId).toBe(valid);
  });

  it('rejects a non-UUID string', () => {
    expect(JobStatusInput.safeParse({ jobId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a valid UUID missing the field', () => {
    expect(JobStatusInput.safeParse({}).success).toBe(false);
  });
});

describe('createJobStatusHandler', () => {
  it('returns the stored JobStatus for a known ID', async () => {
    const time = { now: () => 1_700_000_000_000 };
    const wait = deferred<JobExecutionResult>();
    const manager = createJobManager({ now: time.now });
    const accepted = manager.submit('generate_podcast', async () => wait.promise);
    wait.resolve({ status: 'succeeded', result: { ok: true } });
    await flush();

    const mcpResult = await createJobStatusHandler(manager)({ jobId: accepted.jobId });
    expect(mcpResult.content).toHaveLength(1);
    expect(mcpResult.content[0].type).toBe('text');
    expect(mcpResult.isError).toBeUndefined();
    expect(JSON.parse(mcpResult.content[0].text)).toEqual(mcpResult.structuredContent);
  });

  it('returns error for unknown ID', async () => {
    const result = await createJobStatusHandler(makeJobManager(1_700_000_000_000))({ jobId: randomUUID() });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)).toEqual({ errorCode: 'job_not_found', message: 'Job not found' });
  });

  it('does not mutate the job store on unknown ID lookup', async () => {
    const manager = createJobManager({ now: () => 1_700_000_000_000 });
    const wait = deferred<JobExecutionResult>();
    const accepted = manager.submit('generate_podcast', async () => wait.promise);
    wait.resolve({ status: 'succeeded', result: { done: true } });
    await flush();
    const snapshot = manager.get(accepted.jobId);

    await createJobStatusHandler(manager)({ jobId: randomUUID() });
    expect(manager.get(accepted.jobId)).toEqual(snapshot);
    expect(manager.get(randomUUID())).toBeUndefined();
  });
});

describe('toMcpToolResult helper', () => {
  it('produces matching text and structuredContent', () => {
    const payload = { foo: 'bar', nested: { count: 1 } };
    const result = toMcpToolResult(payload);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
    expect(result.structuredContent).toEqual(payload);
    expect(result.isError).toBeUndefined();
  });

  it('flags isError when requested', () => {
    const payload = { errorCode: 'job_not_found', message: 'Job not found' };
    const result = toMcpToolResult(payload, true);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
    expect(result.structuredContent).toEqual(payload);
  });
});
