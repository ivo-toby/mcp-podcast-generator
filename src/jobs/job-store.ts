import type { JobOperation, JobStage, JobStatusValue, JobError, JobStatus, JsonObject } from './job-types.js';

/** Internal in-process record — executor closures are never stored here */
interface JobRecord {
  jobId: string;
  operation: JobOperation;
  status: JobStatusValue;
  stage: JobStage;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  result?: JsonObject;
  error?: JobError;
}

export class JobStore {
  private records = new Map<string, JobRecord>();

  constructor(
    private readonly now: () => number,
    private readonly retentionMs: number,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  create(jobId: string, operation: JobOperation, createdAt: number): void {
    // Submission is a normal store access. Prune here as well as on lookup so
    // a workload that never polls cannot retain terminal records forever.
    this.pruneExpired();
    this.records.set(jobId, {
      jobId,
      operation,
      status: 'queued',
      stage: 'queued',
      createdAt,
      updatedAt: createdAt,
    });
  }

  update(jobId: string, partial: Partial<JobRecord>): void {
    this.pruneExpired();
    const rec = this.records.get(jobId);
    if (!rec) return;
    Object.assign(rec, partial);
    rec.updatedAt = this.now();
  }

  // ── Lookup (with lazy terminal pruning) ──────────────────────────────────

  get(jobId: string): JobStatus | undefined {
    this.pruneExpired();
    const rec = this.records.get(jobId);
    if (!rec) return undefined;
    return this.toSnapshot(rec);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private toSnapshot(rec: JobRecord): JobStatus {
    return {
      jobId: rec.jobId,
      operation: rec.operation,
      status: rec.status,
      stage: rec.stage,
      createdAt: new Date(rec.createdAt).toISOString(),
      startedAt:
        rec.startedAt !== undefined
          ? new Date(rec.startedAt).toISOString()
          : undefined,
      updatedAt: new Date(rec.updatedAt).toISOString(),
      completedAt:
        rec.completedAt !== undefined
          ? new Date(rec.completedAt).toISOString()
          : undefined,
      message: undefined,
      result: rec.result !== undefined ? structuredClone(rec.result) : undefined,
      error: rec.error ? { ...rec.error } : undefined,
    };
  }

  /** Remove terminal records whose `completedAt` is >= retentionMs old */
  private pruneExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, rec] of this.records) {
      if (
        (rec.status === 'succeeded' || rec.status === 'failed') &&
        rec.completedAt !== undefined &&
        rec.completedAt <= cutoff
      ) {
        this.records.delete(id);
      }
    }
  }
}
