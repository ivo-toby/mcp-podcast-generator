---
name: mcp-podcast-generator
description: Use the podcast generator MCP server to turn scripts into single- or dual-host MP3 episodes, optionally add intro/outro music, and publish completed episodes to configured S3-compatible storage and RSS feeds.
---

# MCP Podcast Generator

Use this skill when the user asks to create, narrate, assemble, download, or
publish a podcast episode through the mcp-podcast-generator MCP server.

## Tool visibility and user intent

The server reads EXPOSE_SEPARATE_TOOLS at process startup:

- By default (absent, empty, or any value other than the literal true), only
  generate_and_publish and get_job_status are exposed.
- When it is exactly true, generate_podcast and publish_podcast are exposed in
  addition to those default tools. Changing the value requires a restart.

Respect whether the user requested publishing:

- If the user asks to create an MP3 only, use generate_podcast when it is
  available. Do not call generate_and_publish just because it is the default:
  that operation always attempts publishing. If separate generation is not
  exposed, explain that the operator must enable EXPOSE_SEPARATE_TOOLS=true and
  restart the server; do not silently publish.
- If the user asks to create and publish an episode, use the default
  generate_and_publish operation. It generates once and passes that output to
  the publishing core once.
- If the user asks to publish an existing MP3, use publish_podcast when it is
  available. The default tool list has no publish-only operation; ask the
  operator to enable the separate tools when needed.

Never request, print, or include Google API keys, S3 access keys, or secret keys
in tool arguments or responses.

## Asynchronous operation contract

All operation tools are job submissions. They validate input, return a job ID
with status queued, and do not wait for Gemini, FFmpeg, S3, or RSS work. The
accepted response includes operation, stage queued, pollIntervalSeconds (5),
and a message that says to retain the ID, poll get_job_status, and not
resubmit. MCP clients may expose the payload as structuredContent or as JSON
inside a text content block.

The status tool input is:

~~~json
{ "jobId": "7f2d0e3d-8f3d-4f0d-9c5b-3f6c31f3e351" }
~~~

It returns the stored status for a known UUID. A malformed UUID is rejected by
schema validation; a valid but unknown or expired UUID returns
errorCode job_not_found and must stop the polling loop.

After accepting a job:

1. Retain the returned UUID.
2. Poll get_job_status about every five seconds.
3. Continue polling while status is queued or running, using stage
   generating, probing, uploading, or updating_feed as useful progress.
4. Stop at succeeded or failed and inspect result and error.

A slow tool response or client timeout is not a reason to submit generation
again. Polling a terminal job never reruns work. If the process or response was
lost and the ID is unknown, inspect the output/backend before deciding whether
a new request is safe; a missing ID does not prove that no work ran.

Job state is process-local: one FIFO queue runs at most one job at a time,
terminal records are retained for 24 hours, and a process restart loses queued,
running, and stored terminal records. Replicas and containers do not share
state, so route submit and poll to one instance. There is no durable queue,
cancellation, task negotiation, or automatic generation retry.

## Choosing and calling generate_and_publish

Use this operation only when the user requested publishing. It accepts the
union of generation and publishing fields:

~~~json
{
  "type": "single",
  "hosts": [{ "name": "Alex", "voice": "Charon" }],
  "segments": [{ "text": "Text to speak" }],
  "outputFilename": "episode-2026-09-04.mp3",
  "episodeTitle": "Episode title",
  "episodeDescription": "A concise description of the episode."
}
~~~

For a dual-host episode, provide exactly two hosts and add speaker to every
segment. Each speaker must exactly match one host name:

~~~json
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
  "outputFilename": "episode-2026-09-04.mp3",
  "episodeTitle": "Episode title",
  "episodeDescription": "A concise description."
}
~~~

For a single-host episode, use one host and omit speaker. Keep
outputFilename as a simple .mp3 basename without path separators or ..; this
keeps the generated file publishable.

Optional audio controls:

~~~json
{
  "introMusicUrl": "https://cdn.example.com/intro.mp3",
  "outroMusicUrl": "https://cdn.example.com/outro.mp3",
  "fadeInDuration": 2,
  "fadeOutDuration": 3,
  "targetLufs": -16
}
~~~

Use publicly reachable HTTPS music URLs. Fade durations are 0–30 seconds and
targetLufs is -40 to -5; defaults are 2, 3, and -16 respectively.

Optional publishing fields are episodeGuid, episodePublishedAt (RFC 3339),
episodeNumber (positive integer), and episodeSeason (positive integer).
episodeGuid defaults to the filename. Do not change a GUID silently to bypass
rss_duplicate_guid.

## Generation-only operation

When generate_podcast is exposed, it accepts the generation fields without
episode metadata. It synthesizes speech with Google Gemini TTS, assembles the
audio with FFmpeg, applies EBU R128 normalization, and writes an MP3 to the
server output directory. Its terminal result contains outputPath,
durationSeconds, and downloadUrl. On failure, report the error and do not claim
that an episode was created.

## Publishing-only operation

When publish_podcast is exposed, it accepts outputFilename, episodeTitle,
episodeDescription, and the optional publishing metadata above. It reads an
existing MP3 from the output directory, uploads it to S3 when configured, and
updates RSS when configured.

Its terminal PublishResult always has s3 and rss stage statuses:

- succeeded: the stage completed and includes s3Url or feedUrl.
- failed: inspect errorCode and errorMessage.
- skipped: that backend is not configured.

PublishResult.success is true when at least one stage succeeds, not necessarily
both. Report partial success explicitly. If generation succeeded but a combined
publish stage fails, use the retained generation result and downloadUrl; do not
regenerate the audio merely to retry publishing.

Useful error codes include s3_upload_failed, rss_fetch_failed,
rss_create_failed, rss_update_failed, rss_duplicate_guid, file_not_found,
invalid_output_filename, file_too_large, and
no_storage_or_feed_configured. The separate publish tool may be visible even
without a backend; in that case no_storage_or_feed_configured is expected.

Publishing uploads media under the S3 key episodes/<outputFilename>. The S3
bucket or its public CDN must allow public reads for RSS enclosure URLs to
work. RSS feed updates use conditional writes and retry concurrent conflicts;
do not repeat a successful publish without checking both stage results.

## Configuration expectations

The server requires GOOGLE_API_KEY for generation. Publishing backends are
optional:

- S3 requires all five variables together:
  S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, and
  S3_PUBLIC_URL. S3_REGION defaults to us-east-1; S3_FORCE_PATH_STYLE=true
  enables path-style addressing for services that require it.
- RSS requires RSS_FEED_URL, PODCAST_TITLE, PODCAST_DESCRIPTION, PODCAST_LINK,
  and PODCAST_AUTHOR. PODCAST_LANGUAGE defaults to en-us and
  PODCAST_CATEGORIES defaults to Technology.
- In S3 mode, the RSS feed URL must have the same origin as S3_PUBLIC_URL
  because the server derives the object key from that URL.
- In RSS-only mode, PUBLIC_URL is required and must be a public HTTP(S) URL;
  localhost and loopback addresses are rejected. The generated MP3 remains on
  the server and is exposed through its /output/ route.
- RSS authentication (basic auth or API keys) is not supported. The feed
  endpoint must support GET and PUT.

## MCP endpoint

When manual connection details are needed, the server uses a Streamable HTTP
MCP endpoint at POST /mcp and a health endpoint at GET /health. Prefer the
configured MCP tool connection and use raw endpoints only for explicit
connectivity troubleshooting.
