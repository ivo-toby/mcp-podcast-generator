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
  "durationSeconds": 18.4
}
```

Your MP3 is in `./output/first-episode.mp3`.

### 6. Connect an MCP client (optional)

If you're using an MCP-aware client (e.g. Claude Desktop, Cursor), add the server to your MCP configuration:

```json
{
  "mcpServers": {
    "podcast-generator": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http"
    }
  }
}
```

The `generate_podcast` tool will then be available directly from the chat interface.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_API_KEY` | ✅ | — | Google AI Studio API key ([get one here](https://aistudio.google.com/app/apikey)) |
| `OUTPUT_DIR` | | `/output` | Directory where MP3 files are written |
| `TEMP_DIR` | | `/tmp/podcast-gen` | Temporary processing directory |
| `PORT` | | `3000` | HTTP server port |

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
  "durationSeconds": 245.3
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

## Using with an MCP Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "podcast-generator": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http"
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
