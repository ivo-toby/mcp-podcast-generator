import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Executor,
  JobExecutionResult,
  JobManager,
  JobOperation,
  StageReporter,
} from '../jobs/job-types.js';
import { createJobManager } from '../jobs/job-manager.js';
import {
  GeneratePodcastInput,
  type GeneratePodcastInputType,
  type GeneratePodcastOutput,
} from '../tools/generate-podcast.js';
import {
  GenerateAndPublishInput,
  createGenerateAndPublishExecutor,
  type GenerateAndPublishInputType,
} from '../tools/generate-and-publish.js';
import {
  createGenerateExecutor,
  createPublishExecutor,
  type GenerateExecutorDependencies,
  type PublishExecutorDependencies,
} from '../tools/async-job-operation-executors.js';
import {
  PublishPodcastInput,
  type PublishPodcastInput as PublishPodcastInputType,
} from '../tools/publish-podcast.js';
import {
  JobStatusInput,
  createJobStatusHandler,
} from '../tools/job-status.js';
import { toMcpToolResult, type McpToolResult } from '../tools/async-job-response.js';
import type { PublishResult } from '../feed/feed-types.js';

/** The process-wide manager used by the production stateless HTTP server. */
export const processJobManager = createJobManager();

/**
 * The deliberately small logger surface used by async registration.
 * Keeping this interface narrow also makes it possible to verify logging in
 * integration tests without importing or configuring pino.
 */
export interface AsyncJobLogger {
  info(bindings: Record<string, unknown>, message: string): unknown;
  error(bindings: Record<string, unknown>, message: string): unknown;
}

export interface McpServerDependencies {
  /** Generation core. It is invoked only after a valid job is accepted. */
  generate(input: GeneratePodcastInputType): Promise<GeneratePodcastOutput>;
  /** Publish core. It may return no-destination/partial results, but should not throw. */
  publish(
    input: PublishPodcastInputType,
    stageCallback?: (stage: 'probing' | 'uploading' | 'updating_feed') => void,
  ): Promise<PublishResult>;
  /** Public URL used to construct generated-audio download URLs. */
  publicUrl: string;
  /** Set once at startup. It is not read again for each request. */
  exposeSeparateTools?: boolean;
  /** Override only for tests or an embedding application. */
  jobManager?: JobManager;
  /** Optional lifecycle logger; omitted callers use a safe no-op logger. */
  logger?: AsyncJobLogger;
}

const defaultLogger: AsyncJobLogger = {
  info(bindings, message) {
    // Lazy import is intentionally avoided: the runtime passes its configured
    // logger, while this no-op keeps the registration factory dependency-light
    // for consumers that only need an in-memory MCP server in tests.
    void bindings;
    void message;
  },
  error(bindings, message) {
    void bindings;
    void message;
  },
};

/** Parse the startup-only visibility flag exactly as specified. */
export function parseExposeSeparateTools(value: string | undefined): boolean {
  return value === 'true';
}

function logJob(
  log: AsyncJobLogger,
  level: 'info' | 'error',
  bindings: Record<string, unknown>,
  message: string,
): void {
  // Logging is observability only. A misconfigured logger must never turn a
  // successfully completed background operation into a failed job.
  try {
    log[level](bindings, message);
  } catch {
    // Deliberately swallow logger failures; the job manager remains canonical.
  }
}

/**
 * Submit an executor while attaching safe lifecycle logs.
 *
 * The manager may begin a queued executor before `submit` returns. The first
 * microtask in this wrapper leaves enough room for the acceptance object to
 * receive its UUID, and no request/transport object is captured here.
 */
function submitLogged(
  manager: JobManager,
  log: AsyncJobLogger,
  operation: JobOperation,
  executor: Executor,
): McpToolResult {
  let jobId: string | undefined;
  const wrapped: Executor = async (report: StageReporter): Promise<JobExecutionResult> => {
    await Promise.resolve();
    const safeReport: StageReporter = (stage) => {
      if (jobId) {
        logJob(log, 'info', { jobId, operation, stage }, 'Async job stage');
      }
      report(stage);
    };

    try {
      const outcome = await executor(safeReport);
      if (jobId) {
        logJob(
          log,
          outcome.status === 'failed' ? 'error' : 'info',
          { jobId, operation, outcome: outcome.status },
          'Async job finished',
        );
      }
      return outcome;
    } catch {
      // Do not log the exception object: generation inputs and provider errors
      // can contain scripts or credentials. The manager stores a safe error.
      if (jobId) {
        logJob(
          log,
          'error',
          { jobId, operation, outcome: 'failed', errorCode: 'job_execution_failed' },
          'Async job failed',
        );
      }
      throw new Error('Job execution failed');
    }
  };

  const accepted = manager.submit(operation, wrapped);
  jobId = accepted.jobId;
  logJob(
    log,
    'info',
    { jobId: accepted.jobId, operation: accepted.operation, stage: accepted.stage },
    'Async job accepted',
  );
  return toMcpToolResult(accepted);
}

/**
 * Create one stateless MCP server instance.
 *
 * Tool registration is request-scoped, but `jobManager` defaults to the
 * process-wide manager so status requests handled by later server instances
 * can observe work accepted by an earlier request.
 */
export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const manager = dependencies.jobManager ?? processJobManager;
  const log = dependencies.logger ?? defaultLogger;
  const exposeSeparateTools = dependencies.exposeSeparateTools ?? false;

  const generationDependencies: GenerateExecutorDependencies = {
    generate: dependencies.generate,
  };
  const publishDependencies: PublishExecutorDependencies = {
    publish: dependencies.publish,
  };

  const server = new McpServer({
    name: 'podcast-generator',
    version: '1.0.0',
  });

  server.tool(
    'generate_and_publish',
    'Generate a podcast MP3 and publish it as one asynchronous job. Retain the returned jobId and poll get_job_status; do not resubmit while the job is active.',
    GenerateAndPublishInput.shape,
    async (input: GenerateAndPublishInputType) => {
      const executor = createGenerateAndPublishExecutor(input, {
        generate: dependencies.generate,
        publish: dependencies.publish,
      }, dependencies.publicUrl);
      return submitLogged(manager, log, 'generate_and_publish', executor);
    },
  );

  server.tool(
    'get_job_status',
    'Return the current state and terminal result for an asynchronous podcast job. Unknown or expired IDs are not re-run.',
    JobStatusInput.shape,
    createJobStatusHandler(manager),
  );

  if (exposeSeparateTools) {
    server.tool(
      'generate_podcast',
      'Submit asynchronous podcast generation. Retain the returned jobId and poll get_job_status; do not resubmit while the job is active.',
      GeneratePodcastInput.shape,
      async (input: GeneratePodcastInputType) => {
        const executor = createGenerateExecutor(
          input,
          generationDependencies,
          dependencies.publicUrl,
        );
        return submitLogged(manager, log, 'generate_podcast', executor);
      },
    );

    server.tool(
      'publish_podcast',
      'Submit asynchronous publishing for a generated podcast MP3. Retain the returned jobId and poll get_job_status; do not resubmit while the job is active.',
      PublishPodcastInput.shape,
      async (input: PublishPodcastInputType) => {
        const executor = createPublishExecutor(input, publishDependencies);
        return submitLogged(manager, log, 'publish_podcast', executor);
      },
    );
  }

  return server;
}
