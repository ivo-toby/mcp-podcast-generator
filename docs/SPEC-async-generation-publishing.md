# Spec: Asynchronous Generation and Publishing Jobs

## Goal

Make podcast generation and publishing reliable for LLM callers by turning
long-running operations into background jobs. Add one combined
`generate_and_publish` tool that generates the MP3, uploads it, and updates
the feed in one server-owned pipeline; return a job ID immediately; and let
the caller poll `get_job_status` without submitting the generation again.

The existing generation and publishing implementations remain the execution
cores. The change is at the MCP boundary and orchestration layer: tool calls
enqueue work, while a job manager owns execution state and final results.

## In scope

- Add `generate_and_publish` with the union of the current
  `generate_podcast` and `publish_podcast` input fields and their current
  validation/defaults.
- Make `generate_podcast` and `publish_podcast` asynchronous job-submission
  tools when they are exposed.
- Add `get_job_status`, accepting a server-generated job ID and returning
  queued, running, or terminal job state.
- Add `EXPOSE_SEPARATE_TOOLS`, an environment boolean that defaults to
  `false` and controls exposure of the two separate operation tools.
- Keep `generate_and_publish` and `get_job_status` exposed by default.
- Run each accepted job independently of the MCP request/response lifecycle.
- Report the pipeline stage (`generating`, `probing`, `uploading`, or
  `updating_feed`) while work is in progress.
- Preserve the existing S3/RSS behavior, including partial publish results,
  stable publish error codes, file validation, and feed concurrency handling.
- Keep job state in the server process, bound its lifetime, and document the
  single-instance/restart limitation.
- Update tests, README usage, Docker configuration, and environment-variable
  documentation for the asynchronous flow.

## Out of scope

- A durable database, Redis queue, or cross-process job store.
- Resuming a job after process restart or recovering an interrupted upload.
- A second tool for retrying only the publish stages of a failed combined job.
- Client-specific MCP Tasks extension negotiation or `tasks/get` support.
- Cancellation, pause/resume, or arbitrary job priority.
- Changing the audio-generation algorithm, Gemini model, S3 layout, or RSS
  XML contract.
- Changing the current episode metadata fields or adding client-supplied
  idempotency keys.

## Configuration

### `EXPOSE_SEPARATE_TOOLS`

The value is enabled only when it is the literal string `true`; absent,
empty, or any other value means `false`.

| Value | Exposed operation tools | Always exposed |
| --- | --- | --- |
| `false` (default) | `generate_and_publish` | `get_job_status` |
| `true` | `generate_podcast`, `publish_podcast`, `generate_and_publish` | `get_job_status` |

The setting is read at process startup. Changing it requires a server restart.
When separate tools are enabled, `publish_podcast` is exposed even when no
S3 or RSS destination is configured; the resulting job reports the existing
`no_storage_or_feed_configured` failure rather than hiding the tool based on
runtime backend configuration.

The job manager uses one active job at a time. Additional jobs remain queued,
which prevents concurrent TTS/FFmpeg work and large S3 buffers from exceeding
the container's memory budget. Terminal job records are retained in process
memory for 24 hours and then may be removed during normal job-store access.
Job records and running work are lost when the process exits.

## Tool contracts

### Operation tool input

`generate_podcast` keeps its current input:

```typescript
{
  type: "single" | "dual";
  hosts: Array<{ name: string; voice: string }>;
  segments: Array<{ speaker?: string; text: string }>;
  outputFilename: string;
  introMusicUrl?: string;
  outroMusicUrl?: string;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  targetLufs?: number;
}
```

`publish_podcast` keeps its current input:

```typescript
{
  outputFilename: string;
  episodeTitle: string;
  episodeDescription: string;
  episodeNumber?: number;
  episodeSeason?: number;
  episodeGuid?: string;
  episodePublishedAt?: string;
}
```

`generate_and_publish` accepts all fields from both schemas. The
`outputFilename` field is shared and has the existing generation constraint;
all episode metadata is passed unchanged to the existing publish handler.
The combined tool calls the generation core once, then the publish core once
for that same output filename. It does not call the MCP tools recursively.

Schema validation happens before a job is created. Invalid arguments return
the normal MCP tool error and do not return a job ID. Every valid accepted
operation call returns a job ID.

### Immediate operation response

All three operation tools return this shape without waiting for TTS, FFmpeg,
S3, or RSS work to finish:

```typescript
interface JobAccepted {
  jobId: string;              // RFC 4122 version 4 UUID
  operation:
    | "generate_podcast"
    | "publish_podcast"
    | "generate_and_publish";
  status: "queued";
  stage: "queued";
  pollIntervalSeconds: 5;
  message: string;            // explicitly says to poll and not resubmit
}
```

The response includes the object as MCP `structuredContent` and includes the
same serialized JSON in a text content block for clients that only consume
text. The message tells the caller to retain the ID, call `get_job_status`,
and not call the operation again while this job is active.

### `get_job_status`

Input:

```typescript
{ jobId: string } // a UUID returned by an operation tool
```

Known-job response:

```typescript
interface JobStatus {
  jobId: string;
  operation:
    | "generate_podcast"
    | "publish_podcast"
    | "generate_and_publish";
  status: "queued" | "running" | "succeeded" | "failed";
  stage:
    | "queued"
    | "generating"
    | "probing"
    | "uploading"
    | "updating_feed"
    | "completed"
    | "failed";
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  message?: string;
  result?: unknown;
  error?: { code: string; message: string };
}
```

The status tool is intentionally quick and is the canonical source of truth
for long-running work. A valid but unknown or expired ID returns an MCP tool
result with `errorCode: "job_not_found"`; it does not start or repeat work.

For terminal states, `result` contains the existing operation result where
available:

- `generate_podcast`: `GeneratePodcastOutput` plus `downloadUrl`.
- `publish_podcast`: the existing `PublishResult`, including both stage
  results and partial-success semantics.
- `generate_and_publish`:

  ```typescript
  interface GenerateAndPublishResult {
    success: boolean;
    generation?: GeneratePodcastOutput;
    publish?: PublishResult;
    downloadUrl?: string;
  }
  ```

For a successful combined job all three optional fields are present. If
generation fails, `generation` and `publish` are absent and the job's `error`
identifies the generation failure. If generation succeeds but publishing
fails, the status includes the generated audio result and the publish result
so the caller can see that audio exists and does not need to regenerate it.

### Job outcome semantics

- `generate_podcast` succeeds when the existing generation core resolves.
- `publish_podcast` succeeds when its `PublishResult.success` is `true`.
  Existing partial success remains success, with failed stages visible in the
  result.
- `generate_and_publish` succeeds only when generation resolves and
  `PublishResult.success` is `true`. If no publish backend is configured, the
  audio may still exist, but the combined job is `failed` with the existing
  `no_storage_or_feed_configured` result.
- An uncaught executor error becomes `status: "failed"` with stable
  `error.code: "job_execution_failed"`; the worker catches it so it cannot
  become an unhandled background promise rejection.
- The server does not automatically retry generation. Existing S3/RSS retry
  behavior remains inside the publish core.

## Job lifecycle

The state machine is:

| Current state | Event/condition | Next state | Required behavior |
| --- | --- | --- | --- |
| — | Valid operation accepted | `queued` | Create UUID and store the in-process record before returning. |
| `queued` | Single worker becomes available | `running` / `generating` or `probing` | Record `startedAt` and begin exactly one executor. |
| `running` | Generation completes | `running` / `probing` | Combined jobs pass the same output file to publish. |
| `running` | S3 stage begins | `running` / `uploading` | Publish the generated MP3 once. |
| `running` | RSS stage begins | `running` / `updating_feed` | Update/create the configured feed once. |
| `running` | Operation success criteria are met | `succeeded` / `completed` | Store the final result and `completedAt`. |
| `running` | Operation result is unsuccessful or executor throws | `failed` / `failed` | Store stable error information, partial result when available, and `completedAt`. |
| terminal | `get_job_status` poll | unchanged | Return the stored terminal result; never execute again. |
| expired/unknown | `get_job_status` poll | — | Return `job_not_found`; never execute or recreate a job. |

The combined pipeline uses this ordered flow:

```text
queued
  → generating (Gemini TTS + FFmpeg assembly)
  → probing (file validation, size, ffprobe)
  → uploading (only when S3 is configured)
  → updating_feed (only when RSS is configured)
  → completed / failed
```

The publish core remains responsible for deciding whether S3/RSS stages are
skipped and for returning per-stage results. The job manager only mirrors
those stage transitions into status records.

## Acceptance criteria

Verification evidence is recorded in [async-jobs-verification.md](async-jobs-verification.md).

- [x] AC-1: With `EXPOSE_SEPARATE_TOOLS` absent or not exactly `true`,
  `tools/list` contains `generate_and_publish` and `get_job_status`, and does
  not contain `generate_podcast` or `publish_podcast`.
- [x] AC-2: With `EXPOSE_SEPARATE_TOOLS=true`, `tools/list` contains all four
  tools; changing the environment value requires a restart to change the
  list.
- [x] AC-3: A valid call to each operation tool returns a `JobAccepted` object
  with a non-empty UUID before a deferred generation/publish promise resolves.
- [x] AC-4: Two accepted calls receive different job IDs, and polling one ID
  cannot execute or change the other job.
- [x] AC-5: `get_job_status` reports queued/running stage changes and returns a
  terminal result without re-running the executor on repeated polls.
- [x] AC-6: `generate_and_publish` invokes generation exactly once, waits for
  it to finish, then invokes publishing exactly once with the generated
  filename; it never performs an MCP-level second tool call.
- [x] AC-7: Combined-job status exposes `generating`, `probing`,
  `uploading`, and `updating_feed` as applicable, and preserves existing
  partial S3/RSS stage results.
- [x] AC-8: Generation failure prevents publishing; publish failure retains
  the generated-audio result when generation already succeeded; unexpected
  background exceptions become `job_execution_failed` rather than crashing
  the process.
- [x] AC-9: Unknown/expired IDs return `job_not_found` and no operation is
  started; malformed IDs are rejected without creating a job.
- [x] AC-10: The job manager serializes execution, prunes terminal records
  after the documented retention period, and does not capture an MCP
  transport/request object in background work.
- [x] AC-11: Unit and integration tests cover tool visibility, immediate
  responses, queue/state transitions, combined ordering, terminal results,
  failure paths, and the documented polling example passes against the built
  server.
