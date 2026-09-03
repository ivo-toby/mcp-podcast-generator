# mcp-podcast-generator

An MCP (Model Context Protocol) server that generates podcast audio from scripts. It runs in Docker, exposes an HTTP endpoint, and provides a `generate_podcast` tool that:

- Converts scripts to speech using **Google Gemini TTS** (`gemini-2.5-flash-preview-tts`)
- Supports **single-host** monologue and **dual-host** dialogue formats
- Optionally adds **intro/outro music** fetched from any HTTPS URL (Cloudflare R2, S3, etc.)
- Applies **EBU R128 loudness normalization** via FFmpeg
- Outputs the final **MP3** to a volume-mapped `/output` folder

## Getting Started

### Prerequisites

- **Docker** and **Docker Compose** installed ([get Docker](https://docs.docker.com/get-docker/))
- A **Google AI Studio API key** with access to Gemini models ([get one here](https://aistudio.google.com/app/apikey))
- (Optional) An intro/outro MP3 hosted on any HTTPS URL (Cloudflare R2, S3, etc.)

### 1. Clone and configure

```bash
git clone https://github.com/ivo-toby/mcp-podcast-generator.git
cd mcp-podcast-generator

cp .env.example .env
```

Open `.env` and set your API key:

```dotenv
GOOGLE_API_KEY=your_api_key_here
```

### 2. Create the output directory

MP3 files are written to `./output` on the host (mapped to `/output` inside the container):

```bash
mkdir -p output
```

### 3. Start the server

```bash
docker compose up
```

The first run builds the Docker image (a few minutes). On success you'll see:

```
mcp-podcast-generator  | MCP Podcast Generator listening on port 3000
```

To run in the background (detached):

```bash
docker compose up -d
```

### 4. Verify it's running

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### Common Docker operations

```bash
# View logs (follow mode)
docker compose logs -f

# Stop the server
docker compose down

# Rebuild the image after code changes
docker compose up --build

# Remove containers and volumes (full reset)
docker compose down -v
```

### 5. Generate your first podcast

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "generate_podcast",
      "arguments": {
        "type": "single",
        "hosts": [{ "name": "Host", "voice": "Kore" }],
        "segments": [
          { "text": "Welcome to my first AI-generated podcast episode." },
          { "text": "Today we explore how easy it is to turn a script into audio." },
          { "text": "Thanks for listening. See you next time!" }
        ],
        "outputFilename": "first-episode.mp3"
      }
    }
  }' | jq .
```

On success you'll get back the output path and duration:

```json
{
  "success": true,
  "outputPath": "/output/first-episode.mp3",
  "durationSeconds": 18.4,
  "downloadUrl": "http://localhost:3000/output/first-episode.mp3"
}
```

Your MP3 is available at `http://localhost:3000/output/first-episode.mp3` and on disk at `./output/first-episode.mp3`.

### 6. Install in Claude Desktop (optional)

With the container running, add the server to Claude Desktop's MCP configuration.

**Find your config file:**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

**Add the server:**

```json
{
  "mcpServers": {
    "podcast-generator": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp"]
    }
  }
}
```

Claude Desktop doesn't support Streamable HTTP directly — `mcp-remote` bridges the connection. `npx` will download it automatically on first run.

If you already have other MCP servers configured, add `podcast-generator` alongside them inside the existing `mcpServers` object.

**Restart Claude Desktop.** The `generate_podcast` tool will appear in the tools panel. You can now ask Claude to generate a podcast directly:

> *"Generate a 5-minute dual-host podcast about the future of open source, using Alex (Charon) and Sam (Aoede), with intro music from https://podcast.briefcast.online/assets/music/intro.mp3, and save it as open-source-ep1.mp3"*

Claude will call the tool and return the output path when done.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_API_KEY` | ✅ | — | Google AI Studio API key ([get one here](https://aistudio.google.com/app/apikey)) |
| `OUTPUT_DIR` | | `/output` | Directory where MP3 files are written |
| `TEMP_DIR` | | `/tmp/podcast-gen` | Temporary processing directory |
| `PORT` | | `3000` | HTTP server port |
| `PUBLIC_URL` | | `http://localhost:3000` | Base URL for download links. For RSS-only mode this **must** be a public HTTP(S) hostname — localhost, 127.0.0.0/8, ::1, fe80::*, and 0.0.0.0 are rejected. |
| `S3_ENDPOINT` | | — | S3-compatible endpoint URL (e.g. `https://s3.amazonaws.com`). All 5 S3 vars must be set together. |
| `S3_REGION` | | `us-east-1` | AWS region. For Cloudflare R2, set to `auto` — R2 is regionless. |
| `S3_ACCESS_KEY_ID` | | — | S3 access key |
| `S3_SECRET_ACCESS_KEY` | | — | S3 secret key |
| `S3_BUCKET` | | — | S3 bucket name |
| `S3_PUBLIC_URL` | | — | Public CDN URL for uploaded files |
| `S3_FORCE_PATH_STYLE` | | `false` | Force path-style URLs. Set to `true` for Cloudflare R2 and MinIO. |
**Cloudflare R2 note:** Replace `<account-id>` in your endpoint with your Cloudflare account ID (found in the dashboard URL). Create an R2 API token with "R2 Objects Read & Write" scope. Set `S3_FORCE_PATH_STYLE=true` — required for R2 since it uses path-style URLs.

| `RSS_FEED_URL` | | — | RSS feed URL to update |
| `PODCAST_TITLE` | | — | Podcast title |
| `PODCAST_DESCRIPTION` | | — | Podcast description |
| `PODCAST_LINK` | | — | Podcast website |
| `PODCAST_AUTHOR` | | — | Podcast author |
| `PODCAST_LANGUAGE` | | `en-us` | Podcast language |
| `PODCAST_CATEGORIES` | | `Technology` | Comma-separated categories |

## Architecture

This server supports two optional backends:

- **S3-compatible storage** — uploads generated MP3s to an S3 bucket or MinIO instance. Uses a `Buffer` (not streams) to avoid AWS SDK v3 retry hangs ([#5479](https://github.com/aws/aws-sdk-js-v3/issues/5479)).
- **RSS feed backend** — maintains an RSS 2.0 feed with iTunes podcast extensions. Uses `xml2js` for XML parsing/building. Supports concurrent PUT with ETag/If-Match retry (412 → re-fetch → re-merge → PUT).

Both backends are abstracted behind `StorageBackend` and `FeedBackend` interfaces so future providers can be added without changing the publish handler.

## Dependencies

| Package | Purpose |
|---|---|
| `@aws-sdk/client-s3` | S3-compatible storage client |
| `xml2js` | RSS feed XML parsing and building |
| `@types/xml2js` | TypeScript types for xml2js |

## Tool: `publish_podcast`

Publish a generated podcast MP3 to S3 storage and/or update the RSS feed.

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `outputFilename` | string | ✅ | MP3 filename (must be `.mp3`) |
| `episodeTitle` | string | ✅ | Episode title (1–250 chars) |
| `episodeDescription` | string | ✅ | Episode description (1–5000 chars) |
| `episodeGuid` | string | | Unique identifier; defaults to filename |
| `episodePublishedAt` | string | | RFC 3339 datetime; defaults to now |
| `episodeNumber` | number | | Episode number |
| `episodeSeason` | number | | Season number |

### Output

```typescript
{
  success: boolean;
  stages: {
    s3: { status: 'succeeded' | 'failed' | 'skipped'; errorCode?: string; s3Url?: string };
    rss: { status: 'succeeded' | 'failed' | 'skipped'; errorCode?: string; feedUrl?: string };
  };
  fileSizeBytes?: number;
  durationSeconds?: number;
  errorCode?: string;
  probeStatFailed?: boolean;
  probeFFprobeFailed?: boolean;
}
```

### Concurrency model

RSS PUT uses ETag-based concurrency control:
- `412 Precondition Failed` → re-fetch feed, re-merge episode, PUT with new `If-Match`
- `409 Conflict` → re-fetch (GET). If 200 → update mode; if 404 → create mode with `If-None-Match: *`
- Max 3 PUT attempts before failing

### Limitations

- **RSS authentication** — Basic auth / API keys for feed URLs are not supported. Feed URLs must be publicly accessible.
- **S3 public-read** — The bucket (or CDN) must allow public read for enclosure URLs to work.
- **ETag precision** — If the feed server returns imprecise or missing ETags, concurrency falls back to last-write-wins.
- **RSS-only** — When S3 is not configured, `PUBLIC_URL` is required and must be a public HTTP(S) URL (no loopback/localhost ranges).
- **File size** — Files over 500 MB are rejected. The entire file is read into a Buffer for upload (to avoid stream retry issues).
- **No streaming** — Large files are buffered in memory. For very large files consider increasing heap (`--max-old-space-size`).

## MCP Endpoint

**POST** `/mcp` — Streamable HTTP transport (JSON-RPC 2.0)

**GET** `/health` — Health check, returns `{ "status": "ok" }`

## Tool: `generate_podcast`

### Input Schema

```typescript
{
  // "single" = one host monologue, "dual" = two-host dialogue
  type: "single" | "dual";

  // Host configurations (1 for single, exactly 2 for dual)
  hosts: Array<{
    name: string;   // Speaker label, e.g. "Alex"
    voice: string;  // Gemini prebuilt voice name (see list below)
  }>;

  // Script segments
  segments: Array<{
    speaker?: string;  // Must match a host name (required for dual-host)
    text: string;      // The text to speak
  }>;

  // Output filename (written to OUTPUT_DIR)
  outputFilename: string;  // e.g. "episode-2026-04-02.mp3"

  // Optional music (any HTTPS URL: R2, S3, etc.)
  introMusicUrl?: string;
  outroMusicUrl?: string;

  // Audio processing options
  fadeInDuration?: number;   // seconds, default 2
  fadeOutDuration?: number;  // seconds, default 3
  targetLufs?: number;       // LUFS target, default -16
}
```

### Output

```json
{
  "success": true,
  "outputPath": "/output/episode-2026-04-02.mp3",
  "durationSeconds": 245.3,
  "downloadUrl": "http://localhost:3000/output/episode-2026-04-02.mp3"
}
```

## Available Gemini Voices

| Voice | Character |
|---|---|
| `Aoede` | Warm, storytelling |
| `Charon` | Deep, authoritative |
| `Fenrir` | Bold, energetic |
| `Kore` | Clear, professional |
| `Puck` | Bright, conversational |
| `Orbit` | Smooth, measured |
| `Perseus` | Confident, direct |
| `Tethys` | Calm, thoughtful |
| `Vega` | Dynamic, expressive |
| `Zubenelgenubi` | Distinctive, memorable |

## Example MCP Calls

### Single Host

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "generate_podcast",
    "arguments": {
      "type": "single",
      "hosts": [{ "name": "Alex", "voice": "Charon" }],
      "segments": [
        { "text": "Welcome to Tech Weekly, your daily dose of AI news." },
        { "text": "Today we're covering the latest developments in language models." },
        { "text": "That's all for today. Thanks for listening!" }
      ],
      "outputFilename": "episode-2026-04-02.mp3",
      "introMusicUrl": "https://your-bucket.r2.dev/intro.mp3",
      "outroMusicUrl": "https://your-bucket.r2.dev/outro.mp3"
    }
  }
}
```

### Dual Host

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "generate_podcast",
    "arguments": {
      "type": "dual",
      "hosts": [
        { "name": "Alex", "voice": "Charon" },
        { "name": "Sam",  "voice": "Puck"   }
      ],
      "segments": [
        { "speaker": "Alex", "text": "Welcome back to the show! I'm Alex." },
        { "speaker": "Sam",  "text": "And I'm Sam. Today we're talking about MCP servers." },
        { "speaker": "Alex", "text": "It's a fascinating topic. Let's dive in." },
        { "speaker": "Sam",  "text": "Absolutely. Thanks everyone for listening!" }
      ],
      "outputFilename": "episode-dual-2026-04-02.mp3",
      "introMusicUrl": "https://your-bucket.r2.dev/intro.mp3",
      "outroMusicUrl": "https://your-bucket.r2.dev/outro.mp3",
      "fadeInDuration": 3,
      "fadeOutDuration": 4,
      "targetLufs": -16
    }
  }
}
```

### curl Example

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "generate_podcast",
      "arguments": {
        "type": "single",
        "hosts": [{ "name": "Host", "voice": "Kore" }],
        "segments": [{ "text": "Hello world, this is a test podcast episode." }],
        "outputFilename": "test.mp3"
      }
    }
  }'
```

## Audio Pipeline

```
Input Script
     │
     ▼
Gemini TTS (gemini-2.5-flash-preview-tts)
     │  PCM 24kHz 16-bit mono (base64)
     ▼
FFmpeg: PCM → MP3 (192kbps libmp3lame)
     │
     ▼
EBU R128 Normalization (two-pass, target: -16 LUFS)
     │
     ├── [intro music URL] → download → fade-in
     │
     ├── TTS audio (normalized)
     │
     └── [outro music URL] → download → fade-out
          │
          ▼
     FFmpeg concat (re-encoded, avoids frame boundary issues)
          │
          ▼
     Final EBU R128 normalization pass
          │
          ▼
     /output/episode.mp3
```

## S3 Upload & RSS Publishing

Optionally configure S3 storage and RSS feed publishing by setting environment variables.

### S3 Storage

Upload generated MP3s to an S3-compatible bucket:

```bash
export S3_ENDPOINT=https://s3.amazonaws.com
export S3_ACCESS_KEY_ID=...
export S3_SECRET_ACCESS_KEY=...
export S3_BUCKET=my-podcasts
export S3_PUBLIC_URL=https://cdn.example.com
```

All five variables must be set together — omit all to disable.

### RSS Feed

Maintain an RSS 2.0 feed that the `publish_podcast` tool updates on each call:

```bash
export RSS_FEED_URL=https://cdn.example.com/podcast.xml
export PODCAST_TITLE=My Podcast
export PODCAST_DESCRIPTION=A podcast about engineering
export PODCAST_LINK=https://example.com
export PODCAST_AUTHOR=Jane Doe
```

Omit all to disable RSS. `PODCAST_LANGUAGE` defaults to `en-us`; `PODCAST_CATEGORIES` defaults to `Technology`.

**RSS-only mode** (S3 not configured): `PUBLIC_URL` must be set and must resolve to a public HTTP(S) hostname — `localhost`, `127.*`, `::1`, `fe80::*`, and `0.0.0.0` are rejected. Malformed or non-HTTP(S) URLs also fail.

### Publish Tool

The `publish_podcast` MCP tool reads an existing MP3, uploads it to S3 (if configured), and appends an episode entry to the RSS feed (if configured). It validates the output file, probes duration with `ffprobe`, and returns structured per-stage results.

## Using with an MCP Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "podcast-generator": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp"]
    }
  }
}
```

## Development

```bash
npm install
npm run dev   # runs tsx src/index.ts directly
```

Requires `ffmpeg` and `ffprobe` installed locally for development.

## Related

- [briefcast](https://github.com/ivo-toby/briefcast) — Full podcast pipeline that uses this server for audio generation
