# Async jobs delivery and verification

This delivery completes [the async jobs spec](SPEC-async-generation-publishing.md).
It is one integrated implementation, not a merge of every TinySDD experiment.

## Selected implementation

- Job core: accepted Qwen Q5 baseline plus Titan Qwen 3.6 medium-reasoning
  repair (`worker-2026-09-06T07-11-14-585Z-e74bba33`).
- Combined executor: accepted Titan Qwen 3.6 medium candidate
  (`worker-2026-09-06T07-33-52-733Z-1e46dcdc`).
- Status response: accepted Qwen 3.6 revision
  (`worker-2026-09-06T11-08-08-437Z-541ae0c9`).
- Standalone operation executors: Qwen 3.8 Q4_K_S candidate
  (`worker-2026-09-06T12-58-53-384Z-6fd5bba8`), with subsequent cleanup.
- Final integration, contract repairs, regression tests, and documentation:
  Luna-max implementation with coordinating-agent review on 2026-09-07.

The original candidate workspaces and model profiles remain local benchmark
evidence, ignored under `.tinysdd/` and `profiles/`. They are not runtime
dependencies. The implementation in `src/` and tests in `tests/` are authoritative;
the final integration includes corrections beyond the earlier acceptance reviews.

## Verification scope

Verification uses fake generation/publishing dependencies, mocked storage/feed
backends, and local HTTP fixtures. It must not consume a live Gemini key, publish
an episode, update a production feed, or deploy the server.

A successful fake path proves the async boundary, not real-provider availability
or audio quality. No Docker image deployment or live-provider test was performed.

The review checks these boundaries independently of the worker's completion
message:

- AC-1/2: actual MCP tool discovery and exact startup flag handling.
- AC-3/4/5: deferred acceptance, distinct job IDs, cross-request status, and
  repeated polls without additional execution.
- AC-6/7/8: combined ordering, stage callbacks, partial success, retained audio
  on publishing failure, and safely handled unexpected errors.
- AC-9/10: malformed/unknown/expired IDs, FIFO execution, detached snapshots,
  terminal retention, and request-independent executor dependencies.
- AC-11: repository regression gates, built HTTP submit/poll smoke, and matching
  README and agent-skill instructions.

Coverage lives in `tests/jobs/job-manager.test.ts`,
`tests/tools/generate-and-publish.test.ts`,
`tests/tools/async-job-operation-executors.test.ts`,
`tests/tools/job-status.test.ts`, and `tests/server/tools.test.ts`, together with
the existing publishing/storage/feed regression suites.

## Observed checks — 2026-09-07

On Node v24.15.0:

- `LOG_LEVEL=silent TMPDIR=/home/ivo/workspace npm test`: 224 tests passed across
  15 files. `TMPDIR` uses the workspace volume because this host's `/tmp` is small;
  it is not an application configuration requirement.
- `LOG_LEVEL=silent npm run test:smoke`: passed. This builds TypeScript and runs
  `scripts/smoke-async-jobs.mjs` against compiled production HTTP/registration
  modules with deferred fake cores and an ephemeral localhost listener. It
  verifies acceptance before completion, later-request polling, the download URL,
  matching structured/text responses, and no rerun on repeated terminal polls.
- The coordinating agent independently ran the seven MCP integration tests;
  all passed, including real HTTP transport closure and later status polling.
- The README curl block was executed against the compiled production HTTP app
  with fake generation/publishing cores, changing only the localhost endpoint
  to an ephemeral port. It reached terminal success with the expected download
  URL and exactly one call to each core.
- The actual `dist/index.js` executable was launched with sanitized environment
  variables, a placeholder API key, and isolated temporary directories. Health
  checks returned HTTP 200. An absent flag and `TRUE` exposed only the two
  default tools; `true` exposed all four. No operation calls were made in this
  executable-discovery check; its child processes and temporary directories
  were cleaned up.
- `docker compose config --quiet`: passed (configuration validation, not a
  container build or deployment).
- The bundled podcast skill passed `quick_validate.py`. Review additionally
  checked that generation-only requests do not silently invoke publishing.

## Operational limits

One process runs one job at a time. Job records are not durable or shared across
replicas; queued/running work and status are lost on restart. Terminal records
expire after 24 hours. There is no automatic generation retry, idempotency key,
or cancellation API. Callers must retain the accepted job ID and poll rather
than submitting the same operation again.
