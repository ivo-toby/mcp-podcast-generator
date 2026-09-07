# Implementation Plan: Asynchronous Generation and Publishing Jobs

This plan implements [SPEC-async-generation-publishing.md](./SPEC-async-generation-publishing.md)
on top of the existing generation and S3/RSS publishing cores. The current
`docs/implementation-plan.md` remains the historical plan for adding the
publishing backends; this plan covers the follow-up async orchestration work.

## Delivery shape

The implementation is split into five bounded workstreams. The first two
establish reusable contracts and execution behavior; the MCP registration
workstream then wires them into the stateless server; tests and documentation
close the external contract.

```text
Job contract/store/queue ─────┐
                              ├─ MCP async adapters + visibility config ── docs/examples
Combined pipeline + stage hook┘
                              └─ integration verification
```

No new runtime dependency is planned. Use Node's `randomUUID` and the
existing Zod, Vitest, MCP SDK, storage, feed, and audio modules.

## Workstream 1 — Job domain and single-worker queue

### Objective

Create a process-local job manager that accepts an executor, returns a UUID
immediately, serializes work, records stage transitions, captures terminal
results, and safely handles rejected background promises.

### Files

- Add `src/jobs/job-types.ts` for operation names, lifecycle states, stages,
  accepted responses, status records, and error shapes.
- Add `src/jobs/job-store.ts` for the in-memory record map, updates, terminal
  retention timestamps, lookup, and lazy pruning.
- Add `src/jobs/job-manager.ts` for UUID creation, FIFO scheduling, one active
  job, executor isolation, and stage-update callbacks.
- Add `src/jobs/index.ts` for exports.
- Add `tests/jobs/job-store.test.ts` and `tests/jobs/job-manager.test.ts`.

### Required behavior

- Create and store the job in process memory before scheduling the executor.
- Use `randomUUID()` for every accepted job; never derive IDs from filenames
  or timestamps alone.
- Return a snapshot copy from status lookup so callers cannot mutate records.
- Update `createdAt`, `updatedAt`, `startedAt`, and `completedAt` consistently.
- Keep the full validated input in the executor closure only; do not put it in
  the status record.
- Execute at most one job at a time and preserve FIFO order.
- Catch all executor errors and store `job_execution_failed` with a safe
  message; no unhandled rejection may escape.
- Keep terminal records for 24 hours and return `undefined` after pruning.

### Verification

- Unit test immediate acceptance with a deferred executor and prove the
  submit call resolves before the executor resolves.
- Unit test queued → running → succeeded and queued → running → failed.
- Unit test FIFO order, stage updates, unique IDs, repeated terminal lookup,
  unknown IDs, and retention pruning.
- Independent check: a real `randomUUID()` call matches the UUID contract and
  two submissions never share an ID.

## Workstream 2 — Combined pipeline and publish-stage reporting

### Objective

Expose a combined input schema and an executor that runs generation exactly
once, then reuses the existing publish handler against the generated output.
Add stage hooks to the publish core so the job manager can report probing,
uploading, and feed-update stages.

### Files

- Add `src/tools/generate-and-publish.ts` for the merged Zod input, inferred
  type, combined result type, and sequential executor.
- Modify `src/tools/publish-podcast.ts` to accept an optional per-invocation
  stage callback and emit `probing`, `uploading`, and `updating_feed` at the
  existing stage boundaries. Preserve one-argument callers and all current
  `PublishResult` behavior.
- Modify `src/tools/generate-podcast.ts` only where needed to expose a clean
  executor boundary; retain its existing output and validation behavior.
- Add `tests/tools/generate-and-publish.test.ts` and extend
  `tests/tools/publish-podcast.test.ts` for stage callbacks.

### Required behavior

- Build the combined schema from the two current schemas without losing
  generation defaults or the generation `outputFilename` constraint. The
  merge order must not replace that field with the looser publish schema.
- Pass only publish fields to the publish handler after generation; do not
  make an MCP call from inside the executor.
- Set `generating` before `generatePodcast` and do not enter any publish stage
  if generation rejects.
- Set `probing` before the publish core performs file checks/ffprobe; let the
  publish callback report `uploading` and `updating_feed` as applicable.
- Preserve the generated result when a later publish stage fails.
- Define combined `success` as generation success plus
  `PublishResult.success`, while preserving per-stage partial success inside
  `publish`.
- Do not add automatic generation retries.

### Verification

- Unit test the merged schema with every generation field, every publishing
  field, and all existing defaults.
- Use deferred mocks to assert call order and exactly one generation call and
  one publish call.
- Test generation rejection prevents publish and combined publish failure
  retains the generated result.
- Test stage callback order for S3+RSS, S3-only, RSS-only, and no-destination
  paths.
- Independent check: reuse the existing `PublishResult` tests and verify the
  existing S3/RSS stage semantics remain unchanged when no callback is passed.

## Workstream 3 — MCP adapters, status tool, and exposure configuration

### Objective

Change the MCP boundary so operation tools enqueue jobs and return immediately;
add the status tool; and make the default tool list contain only the combined
operation plus status.

### Files

- Add `src/tools/job-status.ts` for the `get_job_status` Zod schema, lookup,
  unknown/expired-ID result, and shared result serialization.
- Add `src/tools/async-job-response.ts` (or equivalent) for the common
  accepted-response shape and structured-content/text dual output.
- Modify `src/index.ts` to parse `EXPOSE_SEPARATE_TOOLS`, instantiate one
  process-level job manager, create stable generation/publish dependencies,
  register the combined and status tools, and conditionally register the
  separate tools.
- If needed, extract registration into `src/server/create-mcp-server.ts` so
  tool-list and handler tests do not start the real listener or exit the
  process.
- Add `tests/tools/job-status.test.ts` and an MCP registration/integration test
  such as `tests/server/tools.test.ts`.

### Required behavior

- Validate tool input before submitting a job; schema failures do not create a
  record.
- Register `generate_and_publish` and `get_job_status` unconditionally after
  startup configuration succeeds.
- Register `generate_podcast` and `publish_podcast` only when the env value is
  exactly `true`.
- Make the job manager process-scoped so a status request served by a new
  stateless MCP server instance can find a job submitted by an earlier
  request in the same process.
- Never capture `req`, `res`, `transport`, or MCP `extra` in a background
  executor.
- Return the accepted object immediately and include the explicit “poll, do
  not resubmit” message in both structured and text output.
- Return final results through `get_job_status`, not from the original
  operation response.
- Log job ID, operation, stage, and terminal outcome without logging the full
  script or credentials.

### Verification

- Test default and opt-in tool lists through `tools/list`.
- Test that a submitted job can be polled through a separate stateless MCP
  request after the original request has completed.
- Test malformed and unknown job IDs, repeated terminal polls, and no
  duplicate executor invocation.
- Test a deferred operation proves the original MCP call returns while the
  operation is still pending.
- Independent check: run the built server smoke test, call
  `generate_and_publish` with mocked cores or a fixture executor, then poll
  using a second MCP request until a terminal status is returned.

## Workstream 4 — Documentation, deployment configuration, and examples

### Objective

Make the default tool workflow obvious to both humans and LLM clients, and
document the lifecycle and process-local limitation.

### Files

- Modify `README.md` to list the default tools, describe
  `EXPOSE_SEPARATE_TOOLS`, replace synchronous examples with
  submit-then-poll examples, document terminal results and failures, and
  explain that the server must remain running.
- Modify `docker-compose.yml` to pass `EXPOSE_SEPARATE_TOOLS` with a default
  of `false`.
- Modify `Dockerfile` only if an image-level default is needed; keep the
  Compose default and application parser consistent.
- Add or update `.env.example` if the repository's documented setup expects
  the file to exist; include the new variable and preserve the existing S3/RSS
  options.
- Add a short cross-reference at the top of the existing publishing spec or
  otherwise make clear that this async spec supersedes its synchronous MCP
  tool-flow statements.

### Verification

- Follow the documented curl/MCP sequence against the built server and verify
  the accepted response contains a job ID and the status call returns the
  matching operation.
- Check the default Docker environment exposes only the combined/status tools.
- Independent check: a fresh reader can determine from README alone that a
  timeout or long-running status is not a reason to call generation again.

## Workstream 5 — Final verification and handoff

Run the repository gates after all workstreams are merged:

```bash
npm test
npm run build
```

Also run a focused integration smoke test that:

1. Starts the built server with a test configuration.
2. Lists tools and verifies the default exposure contract.
3. Submits one combined job and receives `status: "queued"` plus `jobId`.
4. Polls `get_job_status` until `succeeded` or `failed` without submitting a
   second generation call.
5. Shuts the server down cleanly.

The implementation is complete when every acceptance criterion in the spec
has a test or an explicit smoke-check assertion, the build and tests pass,
and README instructions match the actual tool response shapes.
