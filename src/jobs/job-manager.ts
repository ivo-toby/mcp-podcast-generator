import { randomUUID } from 'node:crypto';
import type {
  JobAccepted,
  JobManager,
  JobManagerOptions,
  JobOperation,
  JobStage,
  JobStatus,
  Executor,
  StageReporter,
  JobError,
} from './job-types.js';
import { JobStore } from './job-store.js';

const DEFAULT_RETENTION_MS = 86_400_000; // 24 hours

const INITIAL_STAGES: Record<JobOperation, JobStage> = {
  generate_podcast: 'generating',
  publish_podcast: 'probing',
  generate_and_publish: 'generating',
};

const ACTIVE_STAGES: ReadonlySet<JobStage> = new Set([
  'generating',
  'probing',
  'uploading',
  'updating_feed',
]);

export function createJobManager(options: JobManagerOptions = {}): JobManager {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const store = new JobStore(now, retentionMs);

  const queue: Array<{
    jobId: string;
    operation: JobOperation;
    executor: Executor;
  }> = [];
  let running = false;

  // ── FIFO drain ───────────────────────────────────────────────────────────

  function drainQueue(): void {
    if (running || queue.length === 0) return;
    running = true;
    const next = queue.shift()!;
    runJob(next.jobId, next.operation, next.executor);
  }

  // ── Single-job executor runner ───────────────────────────────────────────

  async function runJob(
    jobId: string,
    operation: JobOperation,
    executor: Executor,
  ): Promise<void> {
    const initialStage = INITIAL_STAGES[operation];

    store.update(jobId, {
      status: 'running',
      stage: initialStage,
      startedAt: now(),
      updatedAt: now(),
    });

    // Stage reporter — only accepts active pipeline stages
    let reporting = true;
    const report: StageReporter = (stage: JobStage) => {
      // Executors may retain a callback and invoke it after they settle. Once
      // a terminal result is being recorded, those late reports must not
      // rewrite the terminal stage or timestamp.
      if (!reporting || !ACTIVE_STAGES.has(stage)) return;
      store.update(jobId, { stage, status: 'running', updatedAt: now() });
    };

    try {
      const execResult = await executor(report);
      reporting = false;

      if (execResult.status === 'succeeded') {
        store.update(jobId, {
          status: 'succeeded',
          stage: 'completed',
          result: execResult.result,
          completedAt: now(),
          updatedAt: now(),
        });
      } else if (execResult.status === 'failed') {
        store.update(jobId, {
          status: 'failed',
          stage: 'failed',
          error: execResult.error,
          result: execResult.result,
          completedAt: now(),
          updatedAt: now(),
        });
      }
    } catch {
      reporting = false;
      const safeError: JobError = {
        code: 'job_execution_failed',
        message: 'Job execution failed',
      };
      store.update(jobId, {
        status: 'failed',
        stage: 'failed',
        error: safeError,
        completedAt: now(),
        updatedAt: now(),
      });
    } finally {
      reporting = false;
      running = false;
      drainQueue();
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    submit(
      operation: JobOperation,
      executor: Executor,
    ): JobAccepted {
      const jobId = randomUUID();
      const createdAt = now();
      store.create(jobId, operation, createdAt);
      queue.push({ jobId, operation, executor });
      drainQueue();

      return {
        jobId,
        operation,
        status: 'queued',
        stage: 'queued',
        pollIntervalSeconds: 5,
        message:
          'Job accepted. Retain this jobId and poll get_job_status for updates. Do not resubmit.',
      };
    },

    get(jobId: string): JobStatus | undefined {
      return store.get(jobId);
    },
  };
}
