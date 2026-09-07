# Research: Async MCP Jobs for Podcast Generation and Publishing

Research date: 2026-09-04

## Conclusion

The server needs an application-level job manager and a normal MCP
`get_job_status` tool. MCP progress notifications are useful for an open
request, but they do not solve the failure mode here: the operation currently
blocks the tool call while the client or an intermediary may time out. The
current MCP Tasks extension is a viable future migration path, but it is an
extension with per-request capability negotiation and protocol methods rather
than a universally available tool. A custom job ID/status contract works with
the repository's current stateless Streamable HTTP transport and with clients
that only understand standard `tools/list` and `tools/call`.

## Repository findings

| Finding | Evidence | Design consequence |
| --- | --- | --- |
| Generation blocks the MCP handler | `src/index.ts:233-265` parses input and awaits `generatePodcast` before returning. | The handler must enqueue work and return before the generation promise resolves. |
| Publishing blocks the MCP handler | `src/index.ts:200-230` parses input and awaits `publishHandler`. | Publishing must use the same job adapter as generation. |
| The MCP server is recreated for every request | `src/index.ts:179-180` defines a fresh-server factory; `src/index.ts:306-325` creates and closes a stateless transport per POST. | Background jobs must not depend on `McpServer`, `StreamableHTTPServerTransport`, or request context. The job manager belongs at module/process scope. |
| Generation already exposes a reusable async core | `src/tools/generate-podcast.ts:77-80` returns a `Promise<GeneratePodcastOutput>`. | Keep the core function and wrap it at the MCP boundary. |
| Publishing already has per-stage results | `src/tools/publish-podcast.ts:299-391` runs S3 and RSS stages and returns a `PublishResult`. | The combined executor can compose the existing core and preserve partial success. |
| S3/RSS implementations already have their own bounded operations | `src/feed/rss-feed.ts:35-37` defines feed/network limits; `src/tools/publish-podcast.ts:459-509` bounds ffprobe. | The async job layer needs state reporting, not a second retry implementation. |
| The repository targets Node 20 | `Dockerfile:17-19` uses `node:20-alpine`. | Built-in `node:crypto.randomUUID()` is available; no UUID dependency is required. |
| The declared SDK range is broad | `package.json:14` declares `^1.12.0`; the lockfile currently resolves `1.29.0` at `package-lock.json:1096-1099`. | Do not couple the feature to an experimental SDK-only API without an explicit dependency decision. |

## MCP protocol options considered

### 1. Keep the request open and send progress

The MCP Progress specification lets a client include a `progressToken` and
lets the server send progress, a current value, an optional total, and a
message. The official specification describes this as progress for a request,
not as a durable operation handle: [MCP Progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress).

The lifecycle specification also says senders may stop waiting after a
timeout and issue cancellation, while progress may reset a timeout only when
the client chooses to support that behavior. A maximum timeout remains
recommended: [MCP Lifecycle — timeouts](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts).

This option does not address the reported behavior. A disconnected or timed
out request does not give the LLM a stable application result to retrieve,
and a progress notification is not a replacement for a status lookup.

### 2. Adopt the MCP Tasks extension

The current MCP documentation describes Tasks as asynchronous execution for
long-running operations. A task returns a server-generated handle, exposes
status, and allows a client to poll after reconnecting: [MCP Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview).

The draft extension defines `tasks/get`, `tasks/update`, and `tasks/cancel`,
uses `resultType: "task"`, and requires the client to advertise
`io.modelcontextprotocol/tasks` before the server returns a task result:
[MCP Tasks draft specification](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks).

This repository's requested interface is explicitly a tool named
`get_job_status`, and the problem is client reliability. Using the extension
would make the first response polymorphic and would require every client to
understand extension negotiation. The implementation plan therefore keeps
the standard tool contract and leaves native Tasks as a future compatibility
adapter. The job manager's internal state model mirrors the extension closely
enough that a later adapter would not require rewriting generation or feed
logic.

### 3. Application-level job ID plus status tool — selected

This option has the smallest protocol surface:

1. Validate the input synchronously.
2. Create a cryptographically random UUID and an in-process job record.
3. Return `{ jobId, status: "queued" }` immediately.
4. Execute from a single-worker FIFO queue independent of the HTTP request.
5. Expose `get_job_status({ jobId })` through the normal MCP tools API.

The MCP Tools specification defines the standard discovery/call flow and
allows structured tool output alongside text content: [MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
The server will return both forms so older text-oriented clients and newer
structured-output clients receive the same job contract.

Node's built-in `randomUUID()` generates an RFC 4122 version 4 UUID with a
cryptographic pseudorandom number generator, which is suitable as an opaque
in-process handle: [Node.js Crypto — `randomUUID`](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions).

## Runtime and transport implications

The current server uses stateless Streamable HTTP. A request creates an MCP
server and transport, calls `handleRequest`, and closes the transport in a
`finally` block. That is a good fit for immediate job acceptance only if the
background executor never holds the transport or `extra` request context.
The executor must receive plain validated input, server configuration, and
stage-update callbacks that target the process-local job store.

The process-local store is sufficient for the current single-container
deployment, but it is not durable or shared across replicas. A restart loses
queued/running state; a load-balanced deployment can send a poll to an
instance that does not know the ID. This limitation is explicit in the spec
and is the main reason persistence is a future scope rather than an implicit
promise.

## Selected design constraints

- Use `node:crypto.randomUUID`; do not add a UUID package.
- Parse `EXPOSE_SEPARATE_TOOLS` strictly (`true` enables, everything else
  disables) to make the secure default unambiguous.
- Keep the existing `generatePodcast` and publish handler as reusable cores.
- Add a publish-stage callback or equivalent hook so status can distinguish
  probing, S3 upload, and feed update without duplicating the publish logic.
- Store only job metadata and terminal results; do not echo the full script,
  API credentials, or request context in status records.
- Serialize jobs by default because the existing S3 implementation buffers
  MP3s and the container has a 1 GB memory limit; this also prevents two jobs
  from racing over the same configured RSS feed through the local worker.
- Treat a terminal publish result as data: partial S3/RSS success remains
  visible even when the job itself is marked failed or succeeded according to
  the existing success semantics.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Client polls too aggressively | Return `pollIntervalSeconds: 5` and document a 5-second default. |
| Background promise rejects after MCP response closes | Job runner wraps every executor in `try/catch` and records `job_execution_failed`. |
| Job map grows without bound | Prune terminal records after 24 hours; do not store full input in the record. |
| Two jobs overwrite one output filename | Keep one active worker and document that output filenames remain caller-owned; do not invent idempotency in this scope. |
| Process restart loses status | Document the limitation and keep the job ID/status contract separable from the executor so durable storage can be added later. |
| Experimental MCP APIs change | Use standard tool registration and built-in Node APIs; do not change the SDK dependency for this scope. |
| Tool descriptions cause the LLM to resubmit | Include an explicit accepted-response message and tool descriptions: retain `jobId`, poll status, never resubmit while queued/running. |
