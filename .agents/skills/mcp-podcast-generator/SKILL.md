---
name: mcp-podcast-generator
description: Use the podcast generator MCP server to turn scripts into single- or dual-host MP3 episodes, optionally add intro/outro music, and publish completed episodes to configured S3-compatible storage and RSS feeds.
---

# MCP Podcast Generator

Use this skill when the user asks to create, narrate, assemble, download, or
publish a podcast episode through the `mcp-podcast-generator` MCP server.

## Operating model

The server exposes two tools:

- `generate_podcast` synthesizes speech with Google Gemini TTS, assembles the
  audio with FFmpeg, applies EBU R128 normalization, and writes an MP3 to the
  server's output directory.
- `publish_podcast` takes an MP3 that already exists in the output directory,
  uploads it to S3-compatible storage and/or updates an RSS feed, depending on
  server configuration.

Use `generate_podcast` first. Call `publish_podcast` only after generation
returns `success: true`, and pass the output filename (basename), not the full
`outputPath`.

Before acting, inspect the available MCP tools. `publish_podcast` is registered
only when S3 or RSS publishing is configured; generation remains available
when publishing is disabled.

Generation is intentionally long-running: it commonly takes 2–10 minutes and
may take longer for a long script. Wait for the tool response; do not assume a
timeout or start a duplicate generation request while it is running.

## Choosing and calling `generate_podcast`

Required input:

```json
{
  "type": "single" | "dual",
  "hosts": [
    { "name": "Alex", "voice": "Charon" }
  ],
  "segments": [
    { "text": "Text to speak" }
  ],
  "outputFilename": "episode-2026-09-04.mp3"
}
```

For a dual-host episode, provide exactly two hosts and add `speaker` to every
segment. Each `speaker` must exactly match one host's `name`:

```json
{
  "type": "dual",
  "hosts": [
    { "name": "Alex", "voice": "Charon" },
    { "name": "Sam", "voice": "Puck" }
  ],
  "segments": [
    { "speaker": "Alex", "text": "Welcome to the show." },
    { "speaker": "Sam", "text": "Let's get started." }
  ],
  "outputFilename": "episode-2026-09-04.mp3"
}
```

For a single-host episode, use one host and omit `speaker` from segments. Keep
`outputFilename` as a simple `.mp3` basename without `/`, `\\`, or `..`; this
keeps the generated file publishable and avoids path ambiguity.

Optional audio controls:

```json
{
  "introMusicUrl": "https://cdn.example.com/intro.mp3",
  "outroMusicUrl": "https://cdn.example.com/outro.mp3",
  "fadeInDuration": 2,
  "fadeOutDuration": 3,
  "targetLufs": -16
}
```

Use publicly reachable HTTPS music URLs. Fade durations are in seconds and
must be between 0 and 30. `targetLufs` must be between -40 and -5; the default
of -16 LUFS is appropriate for most podcast episodes.

Available Gemini prebuilt voices include `Aoede`, `Charon`, `Fenrir`, `Kore`,
`Puck`, `Orbit`, `Perseus`, `Tethys`, `Vega`, and `Zubenelgenubi`. Choose a
voice that fits the requested tone and keep voices distinct in dual-host mode.

On success, report the returned `outputPath`, `durationSeconds`, and especially
`downloadUrl` when it is present. On failure, report the returned error and do
not claim that an episode was created.

## Publishing with `publish_podcast`

Required input:

```json
{
  "outputFilename": "episode-2026-09-04.mp3",
  "episodeTitle": "Episode title",
  "episodeDescription": "A concise description of the episode."
}
```

Optional fields:

```json
{
  "episodeGuid": "stable-unique-id",
  "episodePublishedAt": "2026-09-04T13:00:00Z",
  "episodeNumber": 42,
  "episodeSeason": 2
}
```

`episodeGuid` defaults to the filename. Use an explicit stable GUID when the
filename may change, and do not silently change it to bypass an
`rss_duplicate_guid` result. `episodePublishedAt` must be RFC 3339. Episode
title and description are required; title is limited to 250 characters and
description to 5,000 characters.

The result always contains separate `s3` and `rss` stage statuses:

- `succeeded`: the stage completed and includes `s3Url` or `feedUrl`.
- `failed`: inspect `errorCode` and `errorMessage`.
- `skipped`: that backend is not configured.

Overall `success: true` means at least one stage succeeded, not necessarily
both. Report partial success explicitly. Useful failure codes include
`s3_upload_failed`, `rss_fetch_failed`, `rss_create_failed`,
`rss_update_failed`, `rss_duplicate_guid`, `file_not_found`,
`invalid_output_filename`, `file_too_large`, and
`no_storage_or_feed_configured`.

Publishing uploads media under the S3 key `episodes/<outputFilename>`. The
S3 bucket or its public CDN must allow public reads for RSS enclosure URLs to
work. RSS feed updates use conditional writes and retry concurrent conflicts;
do not repeat a successful publish just because the other stage failed without
checking the stage results.

## Configuration expectations

The server requires `GOOGLE_API_KEY` for generation. Publishing backends are
optional:

- S3 requires all five variables together:
  `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, and
  `S3_PUBLIC_URL`. `S3_REGION` defaults to `us-east-1`; set
  `S3_FORCE_PATH_STYLE=true` for services that require path-style addressing.
- RSS requires `RSS_FEED_URL`, `PODCAST_TITLE`, `PODCAST_DESCRIPTION`,
  `PODCAST_LINK`, and `PODCAST_AUTHOR`. `PODCAST_LANGUAGE` defaults to `en-us`
  and `PODCAST_CATEGORIES` defaults to `Technology`.
- In S3 mode, the RSS feed URL must have the same origin as `S3_PUBLIC_URL`
  because the server derives the object key from that URL. A root feed such as
  `<S3_PUBLIC_URL>/podcast.xml` is valid and maps to `podcast.xml`.
- In RSS-only mode, `PUBLIC_URL` is required and must be a public HTTP(S) URL;
  localhost and loopback addresses are rejected. The generated MP3 remains on
  the server and is exposed through its `/output/` route.
- RSS authentication (basic auth or API keys) is not supported. The feed
  endpoint must support the required GET/PUT operations.

Never request, print, or include API keys, S3 access keys, or secret keys in
tool arguments or responses. If a backend is unavailable, explain which
configuration is missing and ask the operator to configure it rather than
inventing URLs or credentials.

## MCP endpoint

When manual connection details are needed, the server uses a Streamable HTTP
MCP endpoint at `POST /mcp` and a health endpoint at `GET /health`. Prefer the
configured MCP tool connection and use these raw endpoints only for explicit
connectivity troubleshooting.
