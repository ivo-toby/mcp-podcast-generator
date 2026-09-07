import { describe, expect, it } from 'vitest';
import { createJobManager } from '../../src/jobs/index.js';
import type { JobExecutionResult, JobOperation } from '../../src/jobs/index.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function clock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    tick: (milliseconds = 1) => { current += milliseconds; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const success = (result: Record<string, unknown>): JobExecutionResult => ({
  status: 'succeeded', result,
});

describe('async job manager', () => {
  it('accepts immediately with a distinct v4 UUID and poll-not-resubmit message', () => {
    const manager = createJobManager();
    const first = manager.submit('generate_podcast', async () => success({ ok: true }));
    const second = manager.submit('publish_podcast', async () => success({ ok: true }));

    for (const accepted of [first, second]) {
      expect(accepted).toMatchObject({ status: 'queued', stage: 'queued', pollIntervalSeconds: 5 });
      expect(accepted.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(accepted.message).toMatch(/poll/i);
      expect(accepted.message).toMatch(/not.*resubmit/i);
    }
    expect(first.jobId).not.toBe(second.jobId);
  });

  it.each<[JobOperation, 'generating' | 'probing']>([
    ['generate_podcast', 'generating'],
    ['publish_podcast', 'probing'],
    ['generate_and_publish', 'generating'],
  ])('starts %s in %s and reports active pipeline stages', async (operation, initialStage) => {
    const wait = deferred<JobExecutionResult>();
    let reportStage!: (stage: 'generating' | 'probing' | 'uploading' | 'updating_feed') => void;
    const manager = createJobManager();
    const accepted = manager.submit(operation, async (report) => {
      reportStage = report;
      return wait.promise;
    });

    expect(manager.get(accepted.jobId)).toMatchObject({ status: 'running', stage: initialStage });
    reportStage('uploading');
    expect(manager.get(accepted.jobId)).toMatchObject({ status: 'running', stage: 'uploading' });
    wait.resolve(success({ value: 'done' }));
    await flush();
    expect(manager.get(accepted.jobId)).toMatchObject({ status: 'succeeded', stage: 'completed', result: { value: 'done' } });
  });

  it('serializes FIFO execution and runs every executor once', async () => {
    const firstGate = deferred<JobExecutionResult>();
    const secondGate = deferred<JobExecutionResult>();
    const order: string[] = [];
    const manager = createJobManager();
    const first = manager.submit('generate_podcast', async () => {
      order.push('first-start');
      return firstGate.promise;
    });
    const second = manager.submit('publish_podcast', async () => {
      order.push('second-start');
      return secondGate.promise;
    });

    expect(order).toEqual(['first-start']);
    expect(manager.get(second.jobId)).toMatchObject({ status: 'queued', stage: 'queued' });
    firstGate.resolve(success({ order: 1 }));
    await flush();
    expect(order).toEqual(['first-start', 'second-start']);
    expect(manager.get(first.jobId)).toMatchObject({ status: 'succeeded', stage: 'completed' });
    secondGate.resolve(success({ order: 2 }));
    await flush();
    expect(manager.get(second.jobId)).toMatchObject({ status: 'succeeded', stage: 'completed' });
    expect(order).toEqual(['first-start', 'second-start']);
  });

  it('records controlled failures with partial results and safe thrown failures before continuing', async () => {
    const manager = createJobManager();
    const controlled = manager.submit('generate_and_publish', async () => ({
      status: 'failed',
      error: { code: 'publish_failed', message: 'Publishing failed' },
      result: { generation: { success: true } },
    }));
    await flush();
    expect(manager.get(controlled.jobId)).toMatchObject({
      status: 'failed', stage: 'failed', error: { code: 'publish_failed', message: 'Publishing failed' },
      result: { generation: { success: true } },
    });

    const thrown = manager.submit('publish_podcast', () => { throw new Error('secret backend detail'); });
    const next = manager.submit('generate_podcast', async () => success({ continued: true }));
    await flush();
    await flush();
    expect(manager.get(thrown.jobId)).toMatchObject({
      status: 'failed', stage: 'failed',
      error: { code: 'job_execution_failed', message: 'Job execution failed' },
    });
    expect(manager.get(next.jobId)).toMatchObject({ status: 'succeeded', stage: 'completed', result: { continued: true } });
  });

  it('returns detached snapshots and polling does not alter terminal timestamps', async () => {
    const time = clock();
    const manager = createJobManager({ now: time.now });
    const accepted = manager.submit('generate_podcast', async () => success({ nested: { value: 1 } }));
    await flush();
    const first = manager.get(accepted.jobId)!;
    const terminalUpdatedAt = first.updatedAt;
    (first.result as { nested: { value: number } }).nested.value = 9;
    time.tick(10_000);
    const second = manager.get(accepted.jobId)!;
    expect(second.updatedAt).toBe(terminalUpdatedAt);
    expect(second.result).toEqual({ nested: { value: 1 } });
  });

  it('ignores stage reports that arrive after an executor reaches a terminal state', async () => {
    let reportStage!: (stage: 'generating' | 'probing' | 'uploading' | 'updating_feed') => void;
    const time = clock();
    const manager = createJobManager({ now: time.now });
    const accepted = manager.submit('generate_podcast', async (report) => {
      reportStage = report;
      return success({ done: true });
    });

    await flush();
    const terminal = manager.get(accepted.jobId)!;
    expect(terminal).toMatchObject({ status: 'succeeded', stage: 'completed' });

    time.tick(10_000);
    reportStage('uploading');

    expect(manager.get(accepted.jobId)).toEqual(terminal);
  });

  it('prunes terminal records at the exact retention boundary but not queued or running records', async () => {
    const time = clock();
    const manager = createJobManager({ now: time.now, retentionMs: 1_000 });
    const terminal = manager.submit('generate_podcast', async () => success({ done: true }));
    const runningGate = deferred<JobExecutionResult>();
    const running = manager.submit('publish_podcast', async () => runningGate.promise);
    await flush();
    expect(manager.get(terminal.jobId)?.status).toBe('succeeded');
    time.tick(999);
    expect(manager.get(terminal.jobId)?.status).toBe('succeeded');
    time.tick(1);
    expect(manager.get(terminal.jobId)).toBeUndefined();
    expect(manager.get(running.jobId)?.status).toBe('running');
    runningGate.resolve(success({ done: true }));
    await flush();
  });

  it('prunes expired terminal records when new jobs are submitted without polling', async () => {
    const time = clock();
    const manager = createJobManager({ now: time.now, retentionMs: 1_000 });
    const first = manager.submit('generate_podcast', async () => success({ first: true }));
    await flush();

    time.tick(1_001);
    const second = manager.submit('generate_podcast', async () => success({ second: true }));
    // Move the clock back before observing the first record. A get-only
    // pruning implementation would retain it at this point, proving that
    // submission itself performed the expiry pass.
    time.tick(-500);

    expect(manager.get(first.jobId)).toBeUndefined();
    await flush();
    expect(manager.get(second.jobId)).toMatchObject({ status: 'succeeded', result: { second: true } });
  });
});
