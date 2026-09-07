import { z } from 'zod';
import type { JobManager } from '../jobs/job-types.js';
import { toMcpToolResult } from './async-job-response.js';

/**
 * Validates that `jobId` is a well-formed UUID.
 */
export const JobStatusInput = z.object({
  jobId: z.string().uuid(),
});

export type JobStatusInputType = z.infer<typeof JobStatusInput>;

/**
 * Create an async handler for the `get_job_status` tool.
 *
 * The returned function accepts a *parsed* `JobStatusInputType` value
 * (i.e. after Zod validation) and returns an MCP tool result object.
 */
export function createJobStatusHandler(
  jobManager: JobManager,
): (input: JobStatusInputType) => Promise<ReturnType<typeof toMcpToolResult>> {
  return async function getJobStatus(input: JobStatusInputType): Promise<ReturnType<typeof toMcpToolResult>> {
    const status = jobManager.get(input.jobId);
    if (status) {
      return toMcpToolResult(status);
    }
    return toMcpToolResult(
      { errorCode: 'job_not_found', message: 'Job not found' },
      true,
    );
  };
}
