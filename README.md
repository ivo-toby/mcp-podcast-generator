# mcp-podcast-generator

An MCP (Model Context Protocol) server that generates podcast audio from
scripts and, when configured, uploads the audio and updates an RSS feed. It
runs in Docker, exposes a Streamable HTTP endpoint, and uses Google Gemini TTS
and FFmpeg.

The MCP operation boundary is asynchronous. A generation or publishing call
returns a job ID immediately; the caller polls get_job_status for progress and
the terminal result. Do not submit the operation again while a job is queued or
running.

## Getting started

### Prerequisites

- Docker and Docker Compose ([install Docker](https://docs.docker.com/get-docker/))
- A Google AI Studio API key ([get one here](https://aistudio.google.com/app/apikey))
- jq for the command-line examples
- Optional intro/outro MP3 files hosted at HTTPS URLs

~~~bash
git clone https://github.com/ivo-toby/mcp-podcast-generator.git
cd mcp-podcast-generator
cp .env.example .env
mkdir -p output
~~~

Set GOOGLE_API_KEY in .env. The default EXPOSE_SEPARATE_TOOLS=false exposes
the combined operation and status tool. The optional S3 and RSS settings can be
left disabled when audio generation is all that is needed.

Start the server after editing .env:

~~~bash
docker compose up --build
~~~

Verify the server:

~~~bash
curl -fsS http://localhost:3000/health | jq .
~~~

Common Docker operations:

~~~bash
docker compose logs -f
docker compose down
docker compose up --build
docker compose down -v
~~~

The server must remain running while jobs execute. Jobs and their status records
are process-local; restarting the container loses queued, running, and
stored terminal jobs, whether or not they were polled.

## Tool visibility and workflow

The environment is read when the process starts:

| EXPOSE_SEPARATE_TOOLS | Exposed operation tools | Always exposed |
| --- | --- | --- |
| absent, empty, or any value other than the literal true | generate_and_publish | get_job_status |
| exactly true | generate_podcast, publish_podcast, generate_and_publish | get_job_status |

Changing the value requires a server restart. With the default configuration,
generate_and_publish always generates and then attempts to publish the same
MP3. It is not a generation-only shortcut. If a user asks only for an MP3,
enable EXPOSE_SEPARATE_TOOLS=true, restart, and use generate_podcast; do not
call the combined tool merely because it is visible by default.

The separate publish_podcast tool is exposed when the flag is exactly true,
even if neither S3 nor RSS is configured. Such a job reaches terminal failure
with no_storage_or_feed_configured rather than disappearing from the tool list.

### Immediate response (breaking response change)

All operation tools validate input, enqueue a job, and return without waiting
for Gemini, FFmpeg, S3, or RSS work. A valid JSON-RPC call returns this MCP
envelope (the text block contains the same serialized payload):

~~~json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "structuredContent": {
      "jobId": "7f2d0e3d-8f3d-4f0d-9c5b-3f6c31f3e351",
      "operation": "generate_and_publish",
      "status": "queued",
      "stage": "queued",
      "pollIntervalSeconds": 5,
      "message": "Job accepted. Retain this jobId and poll get_job_status for updates. Do not resubmit."
    },
    "content": [
      {
        "type": "text",
        "text": "{\"jobId\":\"7f2d0e3d-8f3d-4f0d-9c5b-3f6c31f3e351\",\"operation\":\"generate_and_publish\",\"status\":\"queued\",\"stage\":\"queued\",\"pollIntervalSeconds\":5,\"message\":\"Job accepted. Retain this jobId and poll get_job_status for updates. Do not resubmit.\"}"
      }
    ]
  }
}
~~~

The object is returned as MCP structuredContent and as the same serialized JSON
in a text content block. Invalid arguments fail normal MCP schema validation
and do not create a job. The old synchronous operation response is no longer
returned from the operation call; final output is available only through
get_job_status.

### Polling and terminal results

Call get_job_status with the returned UUID approximately every five seconds:

~~~json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_job_status",
    "arguments": { "jobId": "7f2d0e3d-8f3d-4f0d-9c5b-3f6c31f3e351" }
  }
}
~~~

Known jobs report queued, running, succeeded, or failed. While running, stage is
one of generating, probing, uploading, or updating_feed. Terminal stages are
completed and failed.

~~~json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "structuredContent": {
      "jobId": "7f2d0e3d-8f3d-4f0d-9c5b-3f6c31f3e351",
      "operation": "generate_and_publish",
      "status": "succeeded",
      "stage": "completed",
      "result": {
        "success": true,
        "downloadUrl": "http://localhost:3000/output/episode-42.mp3"
      }
    },
    "content": [
      {
        "type": "text",
        "text": "{\"jobId\":\"7f2d0e3d-8f3d-4f0d-9c5b-3f6c31f3e351\",\"operation\":\"generate_and_publish\",\"status\":\"succeeded\",\"stage\":\"completed\",\"result\":{\"success\":true,\"downloadUrl\":\"http://localhost:3000/output/episode-42.mp3\"}}"
      }
    ]
  }
}
~~~

Terminal result by operation:

- generate_podcast: existing generation output plus downloadUrl.
- publish_podcast: existing PublishResult, including s3 and rss stage results.
- generate_and_publish: generation, publish, and downloadUrl when the combined
  job succeeds.

If generation succeeds but publishing does not, the combined failed status still
includes the generated result and publish result. The audio already exists, so
do not regenerate it; inspect the per-stage result. A generated download link
remains available even when publishing fails. If one publish stage succeeds
while another fails, PublishResult.success remains true and the terminal job
can still be succeeded; the failed stage is retained in result.publish.stages.
If both publish stages fail or are skipped, the combined job is failed. An
uncaught executor exception is reported as error.code: "job_execution_failed".

A valid but unknown or expired ID returns errorCode: "job_not_found" and never
starts work. Polling a terminal job never runs the executor again. Retain the ID
and poll; a slow response or client timeout is not a reason to submit generation
again. If the response or process is lost, an unknown ID is not evidence that
work did not run; inspect the output/backend before deciding on a new request.

### Reproducible curl flow

This uses the default combined tool. It extracts the ID from structuredContent
(and falls back to the text block), then polls until a terminal status:

~~~bash
set -euo pipefail
MCP_URL=http://localhost:3000/mcp

call_mcp() {
  response=$(curl -fsS "$MCP_URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data-binary "$1")
  if jq -e . >/dev/null 2>&1 <<<"$response"; then
    printf '%s\n' "$response"
  else
    # Streamable HTTP may return an SSE envelope: event: message + data: JSON.
    data=$(sed -n 's/^data: //p' <<<"$response" | tail -n 1)
    test -n "$data" || { echo "MCP response was neither JSON nor SSE" >&2; exit 1; }
    printf '%s\n' "$data"
  fi
}

accepted=$(call_mcp '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"generate_and_publish","arguments":{
    "type":"single",
    "hosts":[{"name":"Host","voice":"Kore"}],
    "segments":[{"text":"Welcome to the async podcast demo."}],
    "outputFilename":"async-demo.mp3",
    "episodeTitle":"Async podcast demo",
    "episodeDescription":"A short demonstration of submit-then-poll."
  }}
}')
job_id=$(jq -r '.result.structuredContent.jobId // (.result.content[0].text | fromjson | .jobId)' <<<"$accepted")
test -n "$job_id" && test "$job_id" != null || { echo "No job ID in accepted response" >&2; exit 1; }

while :; do
  status=$(call_mcp "$(jq -cn --arg id "$job_id" '{
    jsonrpc:"2.0",id:2,method:"tools/call",
    params:{name:"get_job_status",arguments:{jobId:$id}}
  }')")
  state=$(jq -r '.result.structuredContent.status // (.result.content[0].text | fromjson | .status // "unknown")' <<<"$status")
  jq '.result.structuredContent // (.result.content[0].text | fromjson)' <<<"$status"
  case "$state" in
    succeeded|failed) break ;;
    queued|running) sleep 5 ;;
    *) echo "Unexpected MCP job status: $state" >&2; exit 1 ;;
  esac
done
~~~

### Job lifetime and deployment limits

- The queue is FIFO and runs at most one job at a time. Later submissions stay
  queued, bounding TTS/FFmpeg work and large S3 buffers.
- Job records live in process memory. Terminal records are retained for 24
  hours and may be pruned during normal job-store access.
- A process restart loses all job records and running work. The server does not
  resume interrupted generation or uploads.
- The job store is not shared across processes, replicas, or containers. Route
  submit and poll requests to the same single instance. A durable queue/database
  is intentionally out of scope.
- There is no cancellation, pause/resume, arbitrary priority, client task
  negotiation, or automatic generation retry.

## Operation inputs

### generate_and_publish

The default combined operation accepts the union of generation and publishing
inputs. Generation runs exactly once, then the generated file is passed to the
publishing core exactly once.

~~~typescript
{
  type: "single" | "dual";
  hosts: Array<{ name: string; voice: string }>;
  segments: Array<{ speaker?: string; text: string }>;
  outputFilename: string;
  introMusicUrl?: string;
  outroMusicUrl?: string;
  fadeInDuration?: number; // default 2, range 0..30
  fadeOutDuration?: number; // default 3, range 0..30
  targetLufs?: number; // default -16, range -40..-5
  episodeTitle: string; // 1..250 characters
  episodeDescription: string; // 1..5000 characters
  episodeNumber?: number; // positive integer
  episodeSeason?: number; // positive integer
  episodeGuid?: string; // defaults to outputFilename
  episodePublishedAt?: string; // RFC 3339; defaults to now
}
~~~

For dual-host episodes provide exactly two hosts and a matching speaker on every
segment. For single-host episodes provide one host and omit speaker.
outputFilename should be a simple .mp3 basename without /, \, or .. so it can
also be published safely.

### generate_podcast (opt-in)

When EXPOSE_SEPARATE_TOOLS=true, this operation accepts the generation fields
above and writes an MP3 to OUTPUT_DIR; it does not publish. Its terminal result
contains outputPath, durationSeconds, and downloadUrl.

### publish_podcast (opt-in)

When EXPOSE_SEPARATE_TOOLS=true, this operation accepts:

~~~typescript
{
  outputFilename: string;
  episodeTitle: string;
  episodeDescription: string;
  episodeNumber?: number;
  episodeSeason?: number;
  episodeGuid?: string;
  episodePublishedAt?: string;
}
~~~

It publishes an existing MP3 in OUTPUT_DIR. It can be exposed even when no
backend is configured; that job returns no_storage_or_feed_configured.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| GOOGLE_API_KEY | yes | — | Google AI Studio API key |
| EXPOSE_SEPARATE_TOOLS | | false | Literal true exposes generate_podcast and publish_podcast; read at startup. |
| OUTPUT_DIR | | /output | Directory where MP3 files are written |
| TEMP_DIR | | /tmp/podcast-gen | Temporary processing directory |
| PORT | | 3000 | HTTP server port |
| LOG_LEVEL | | info | Log level (info, debug, warn, error) |
| PUBLIC_URL | | http://localhost:3000 | Download base URL; public HTTP(S) required for RSS-only mode. |
| S3_ENDPOINT | | — | S3-compatible endpoint; set all required S3 variables together. |
| S3_REGION | | us-east-1 | Signing region; auto is suitable for Cloudflare R2. |
| S3_ACCESS_KEY_ID | | — | S3 access key |
| S3_SECRET_ACCESS_KEY | | — | S3 secret key |
| S3_BUCKET | | — | S3 bucket name |
| S3_PUBLIC_URL | | — | Public base URL for uploaded media |
| S3_FORCE_PATH_STYLE | | false | Path-style addressing where required, such as MinIO; only literal true enables it. |
| RSS_FEED_URL | | — | RSS feed URL that supports GET and PUT |
| PODCAST_TITLE | | — | Podcast title; required when RSS is configured |
| PODCAST_DESCRIPTION | | — | Podcast description; required when RSS is configured |
| PODCAST_LINK | | — | Podcast website; required when RSS is configured |
| PODCAST_AUTHOR | | — | Podcast author; required when RSS is configured |
| PODCAST_LANGUAGE | | en-us | Podcast language |
| PODCAST_CATEGORIES | | Technology | Comma-separated RSS categories |

S3 is disabled when all five required S3 variables are absent. If any is
present, all five (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
S3_BUCKET, and S3_PUBLIC_URL) must be present or startup fails.
S3_FORCE_PATH_STYLE alone does not enable S3.

RSS requires RSS_FEED_URL, PODCAST_TITLE, PODCAST_DESCRIPTION, PODCAST_LINK,
and PODCAST_AUTHOR. Without S3, PUBLIC_URL must be public HTTP(S); localhost
and loopback addresses are rejected because RSS enclosures point at /output/.
With S3, the enclosure uses the uploaded media URL.

## Storage and RSS behavior

The publishing core preserves per-stage results:

~~~typescript
interface PublishResult {
  success: boolean; // true when S3 or RSS succeeds
  stages: { s3: StageResult; rss: StageResult };
  fileSizeBytes?: number;
  durationSeconds?: number;
  probeStatFailed?: boolean;
  probeFFprobeFailed?: boolean;
  errorCode?: string;
}
~~~

An S3 upload uses the key episodes/<outputFilename> and buffers the MP3 for
SDK retry behavior. Files over 500 MB are rejected. RSS updates use ETag and
conditional PUTs, retrying a 412 Precondition Failed or creation conflict up
to three total attempts. Existing channel metadata is preserved and duplicate
GUIDs are rejected.

Stable error codes include file_not_found, invalid_output_filename,
path_traversal_attempted, file_too_large, probe_stat_failed,
probe_ffprobe_failed, s3_upload_failed, rss_fetch_failed, rss_create_failed,
rss_update_failed, rss_duplicate_guid, rss_missing_media_url, and
no_storage_or_feed_configured.

Limitations include no RSS authentication, publicly readable S3/CDN media, and
no streaming upload. If a feed host omits usable ETags, updates fall back to
last-write-wins.

## Architecture

~~~text
MCP operation call
      │ validates and enqueues
      ▼
Process-local FIFO job manager (one active job)
      │
      ├── Gemini TTS + FFmpeg → /output/episode.mp3
      └── S3 upload and/or RSS GET/merge/conditional PUT
      │
      ▼
get_job_status → stage updates and terminal result
~~~

The generation pipeline uses gemini-2.5-flash-preview-tts, converts PCM to MP3
with FFmpeg, and applies EBU R128 normalization (default target -16 LUFS).
Optional intro/outro URLs are downloaded and mixed by the audio assembler.

## Available Gemini voices

| Voice | Character |
|---|---|
| Aoede | Warm, storytelling |
| Charon | Deep, authoritative |
| Fenrir | Bold, energetic |
| Kore | Clear, professional |
| Puck | Bright, conversational |
| Orbit | Smooth, measured |
| Perseus | Confident, direct |
| Tethys | Calm, thoughtful |
| Vega | Dynamic, expressive |
| Zubenelgenubi | Distinctive, memorable |

## MCP endpoint and clients

- POST /mcp — Streamable HTTP transport (JSON-RPC 2.0)
- GET /health — health check
- GET /output/<filename> — generated MP3s served by the HTTP server

For Claude Desktop or another client that needs a stdio bridge:

~~~json
{
  "mcpServers": {
    "podcast-generator": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp"]
    }
  }
}
~~~

With the default tool list, ask the client to generate and publish through
generate_and_publish, then poll get_job_status. For generation-only requests,
enable the separate tools and restart first.

## Development

~~~bash
npm install
npm run dev
~~~

Local development requires ffmpeg and ffprobe. Repository gates:

~~~bash
npm test
npm run build
npm run test:smoke
~~~

## Related

- [Asynchronous generation and publishing spec](docs/SPEC-async-generation-publishing.md)
- [Asynchronous implementation plan](docs/implementation-plan-async-jobs.md)
- [Upload and publish backend spec](docs/SPEC-upload-publish.md)
- [briefcast](https://github.com/ivo-toby/briefcast) — full podcast pipeline
