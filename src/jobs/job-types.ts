/**
 * Core types for the async job system.
 * All types are recursive inert JSON — no functions, no class references.
 */

// ── Recursive JSON types ───────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

// ── Operation names ────────────────────────────────────────────────────────

export type JobOperation =
  | 'generate_podcast'
  | 'publish_podcast'
  | 'generate_and_publish';

// ── Status and stage unions ────────────────────────────────────────────────

/** Terminal or in-progress status */
export type JobStatusValue = 'queued' | 'running' | 'succeeded' | 'failed';

/** Full pipeline stage including queued and terminal stages */
export type JobStage =
  | 'queued'
  | 'generating'
  | 'probing'
  | 'uploading'
  | 'updating_feed'
  | 'completed'
  | 'failed';

// ── Error shape ────────────────────────────────────────────────────────────

export interface JobError {
  code: string;
  message: string;
}

// ── Public response shapes ─────────────────────────────────────────────────

export interface JobAccepted {
  jobId: string;
  operation: JobOperation;
  status: 'queued';
  stage: 'queued';
  pollIntervalSeconds: number;
  message: string;
}

export interface JobStatus {
  jobId: string;
  operation: JobOperation;
  status: JobStatusValue;
  stage: JobStage;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  message?: string;
  result?: JsonObject;
  error?: JobError;
}

// ── Executor contract ──────────────────────────────────────────────────────

/** Typed terminal outcome returned by an executor */
export type JobExecutionResult =
  | { status: 'succeeded'; result: JsonObject }
  | { status: 'failed'; error: JobError; result?: JsonObject };

/** Callback the executor uses to report active pipeline stages */
export type StageReporter = (
  stage: 'generating' | 'probing' | 'uploading' | 'updating_feed'
) => void;

/**
 * Executor receives a stage reporter and resolves a terminal outcome.
 * May throw synchronously or return a rejected promise — both are caught.
 */
export type Executor = (
  report: StageReporter
) => JobExecutionResult | Promise<JobExecutionResult>;

// ── Manager interface ──────────────────────────────────────────────────────

export interface JobManager {
  /** Synchronous submission — returns immediately with a queued acceptance */
  submit(operation: JobOperation, executor: Executor): JobAccepted;
  /** Returns a detached snapshot or `undefined` */
  get(jobId: string): JobStatus | undefined;
}

export interface JobManagerOptions {
  /** Injected clock; defaults to `Date.now` */
  now?: () => number;
  /** Milliseconds after which terminal records may be pruned; defaults to 86 400 000 */
  retentionMs?: number;
}
