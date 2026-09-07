# Upload & Publish: S3 + RSS Feed

> **Current MCP boundary:** The asynchronous contract in
> [SPEC-async-generation-publishing.md](./SPEC-async-generation-publishing.md)
> supersedes the synchronous tool-flow statements in this historical backend
> spec. Operation calls now enqueue jobs and return `JobAccepted`; callers
> retrieve this document's `PublishResult` through `get_job_status`. The
> combined `generate_and_publish` and `get_job_status` tools are exposed by
> default. `generate_podcast` and `publish_podcast` are exposed only when
> `EXPOSE_SEPARATE_TOOLS` is exactly `true` at process startup.

## Goal

After generating a podcast MP3, optionally upload it to S3-compatible storage
and update (or create) an RSS feed. The publishing core remains provider
neutral and returns a per-stage `PublishResult`; asynchronous job orchestration
is defined by the async spec linked above.

## Design Decisions

- **One S3 bucket per server instance.** Configured at startup via env vars. All-or-none validation: either all S3 vars are set, or S3 is disabled.
- **One RSS feed per server instance.** Configured at startup. If the feed doesn't exist at the configured URL, create it. If it exists, append an episode (with ETag/If-Match retry for concurrency safety).
- **Provider-neutral media abstraction.** The feed layer receives `MediaAsset { url, lengthBytes, mimeType }` — never an S3-specific value. In RSS-only mode (no S3), the media URL points to the server's `/output/` route (not an external CDN), because the file is never uploaded anywhere else.
- **Separate operation cores.** Generation writes to `/output`, and publishing
  takes an existing file and pushes to S3 + RSS. If either S3 or RSS isn't
  configured, skip that step silently. Their MCP adapters are opt-in; the
  default client-facing workflow is the combined asynchronous operation.
- **Breaking MCP boundary, stable cores.** The old synchronous operation
  response is replaced by a job-accepted response. The generation and
  publishing input fields and the `PublishResult` backend contract remain
  unchanged.
- **Discriminated response with per-stage status.** Every publish core
  invocation returns a structured result showing which stages succeeded,
  failed, or were skipped.

## Current asynchronous MCP boundary

The backend behavior below is invoked by a process-local asynchronous job
manager. Tool visibility and response shape are defined by
[SPEC-async-generation-publishing.md](./SPEC-async-generation-publishing.md):

- By default, `tools/list` contains `generate_and_publish` and
  `get_job_status`. The combined operation generates once and then publishes
  that output; it is not a generation-only operation.
- When `EXPOSE_SEPARATE_TOOLS` is exactly the literal string `true` at
  startup, `generate_podcast` and `publish_podcast` are also exposed. The
  separate publish tool remains visible even when no backend is configured and
  then reports `no_storage_or_feed_configured`.
- Every valid operation call returns `JobAccepted` immediately with a UUID,
  `status: "queued"`, `stage: "queued"`, a five-second poll interval,
  and a message telling the caller to poll rather than resubmit. It returns
  the same JSON in MCP `structuredContent` and a text content block.
- Callers poll `get_job_status`; a combined job stores the
  `PublishResult` in terminal `result.publish`, while a separate
  `publish_podcast` job stores it directly in terminal `result`. Unknown or
  expired IDs return `errorCode: "job_not_found"` and never execute work.
- A publish result with one successful stage and one failed stage remains
  `success: true`; callers must inspect both stage records. A combined job
  retains the generated result when a later publish stage fails, so the audio
  must not be regenerated automatically.
- Jobs run FIFO with one active executor. Records are process-local, terminal
  records are retained for 24 hours, and a restart loses queued/running work
  and status records. Multiple replicas do not share job state; route submit
  and poll to one instance. There is no durable queue or automatic generation
  retry.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     MCP Server                                │
│                                                               │
│  generation core                                               │
│    → writes MP3 to /output                                    │
│                                                               │
│  publish_podcast (new)                                        │
│    → fs.stat(path) → fileSizeBytes                            │
│    → ffprobe(path) → durationSeconds                          │
│    → StorageBackend.upload(file, key) → MediaAsset            │
│    → FeedBackend.addEpisode(feed, episode, mediaAsset)        │
│    → returns PublishResult { stages: { s3, rss } }            │
└───────────────────────────────┬───────────────────────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              │                                     │
     StorageBackend                      FeedBackend
              │                                     │
     S3StorageBackend                RssFeedBackend (default)
              │                      PodloveFeedBackend (future)
              │                      SpotifyFeedBackend (future)
              │
         MediaAsset (type)
         { url, lengthBytes, mimeType }
```

## Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `src/storage/storage-types.ts` | `StorageBackend` interface + `MediaAsset` type |
| `src/storage/s3-storage.ts` | S3-compatible implementation (uses `@aws-sdk/client-s3` with custom endpoint) |
| `src/storage/index.ts` | Re-export |
| `src/feed/feed-types.ts` | `FeedBackend` interface + `EpisodeMetadata` + `PublishResult` types |
| `src/feed/rss-feed.ts` | Default self-hosted RSS feed implementation (create + update) |
| `src/feed/index.ts` | Re-export |
| `src/tools/publish-podcast.ts` | Zod schema + handler for `publish_podcast` |
| `tests/storage/s3-storage.test.ts` | S3 storage tests |
| `tests/feed/rss-feed.test.ts` | RSS feed tests (mock HTTP) |
| `tests/tools/publish-podcast.test.ts` | Publish tool tests |

### Modified files

| File | Change |
|---|---|
| `package.json` + `package-lock.json` | Add `@aws-sdk/client-s3` and `xml2js` to **dependencies**; add `@types/xml2js` to **devDependencies** |
| `src/index.ts` | Import + register `publish_podcast` tool; read new env vars; validate S3 config; pass storage/feed instances to handler |
| `docker-compose.yml` | Add S3 env vars to environment block |
| `.env.example` | Add S3 + RSS env vars |
| `README.md` | Document new tools, env vars, architecture, concurrency model |

## Environment Variables

### S3 (all-or-none validation)

| Variable | Required | Default | Description |
|---|---|---|---|
| `S3_ENDPOINT` | One of the S3 vars | — | S3-compatible endpoint URL (e.g. `https://s3.amazonaws.com`, `https://account.r2.cloudflarestorage.com`, `http://minio:9000`) |
| `S3_REGION` | Optional | `us-east-1` | Region (used for signing; R2 accepts any value). Defaults to `us-east-1` when absent. |
| `S3_ACCESS_KEY_ID` | One of the S3 vars | — | Access key ID |
| `S3_SECRET_ACCESS_KEY` | One of the S3 vars | — | Secret access key |
| `S3_BUCKET` | One of the S3 vars | — | Bucket name |
| `S3_PUBLIC_URL` | Required when S3 enabled | — | Base URL for public access (e.g. `https://cdn.example.com` or `https://bucket.r2.dev`). **Required whenever S3 is enabled** because `MediaAsset` must always contain a publicly reachable URL for the enclosure. Must be normalized (trailing slash stripped) before URL assembly. Path segments (key, filename) must be encoded before concatenation. |
| `S3_FORCE_PATH_STYLE` | — | `false` | For MinIO and some S3-compatible services, bucket must be a path segment, not a subdomain. Set to `true` for MinIO/self-hosted S3. Ignored for R2/AWS. Parsing: only the literal string `'true'` enables it; all other values (including absent) mean `false`. Setting **only** `S3_FORCE_PATH_STYLE` does **not** enable S3 — it is a boolean flag, not an enabling variable. |

**Validation:** at startup, check the 5 required variables (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`):
- If **none** of the 5 required vars are set → S3 is disabled. `publish_podcast` skips S3 silently.
- If **any** of the 5 required vars is set → ALL 5 must be set. If any is missing, log a fatal error and exit. `S3_REGION` is optional and defaults to `us-east-1` when absent. `S3_FORCE_PATH_STYLE` is a separate boolean flag (only `'true'` enables it; setting only `S3_FORCE_PATH_STYLE` does **not** enable S3).

This means: completely absent = skip. Partially present = fatal exit. `S3_REGION` defaults to `us-east-1` only when absent but other S3 vars are set (before the completeness validation runs).

### RSS Feed

| Variable | Required | Default | Description |
|---|---|---|---|
| `RSS_FEED_URL` | — | — | Full URL of the RSS feed to update (e.g. `https://host.example.com/podcast/feed.xml`). Must support HTTP PUT. |
| `PODCAST_LINK` | **Required if RSS is configured** | — | Base URL of the podcast (e.g. `https://podcasts.example.com`). **Required** for RSS feed creation because RSS 2.0 mandates `<channel><link>` as a required element. |
| `PODCAST_TITLE` | **Required if RSS is configured** | — | Podcast title. Required for RSS feed creation (RSS 2.0 mandates `<channel><title>`). |
| `PODCAST_DESCRIPTION` | **Required if RSS is configured** | — | Podcast description. Required for RSS feed creation (RSS 2.0 mandates `<channel><description>`). |
| `PODCAST_AUTHOR` | **Required if RSS is configured** | — | Podcast author / publisher. Required for RSS feed creation (used in `<itunes:owner>`, `<managingEditor>`, `<itunes:author>`). |
| `PODCAST_LANGUAGE` | — | `en-us` | Podcast language |
| `PODCAST_CATEGORIES` | — | `Technology` | Comma-separated RSS categories |
| `PUBLIC_URL` | **Required if RSS is configured without S3** | — | Base URL for the server (e.g. `http://podcast.example.com`). Required when RSS is configured without S3 because RSS-only publishing needs a public URL for the enclosure element. The file stays on the local filesystem; `PUBLIC_URL` must point to the same server that serves `/output/`. Not a CDN URL. When S3 is configured, `S3_PUBLIC_URL` is used instead. If RSS is configured without S3, `PUBLIC_URL` must NOT be `localhost`, `127.0.0.1`, or `::1` (any port) — startup will error. |

**Validation:** at startup:
- If `RSS_FEED_URL` is set → validate `PODCAST_TITLE`, `PODCAST_DESCRIPTION`, `PODCAST_LINK`, `PODCAST_AUTHOR` are all set, else fatal
- If `RSS_FEED_URL` is set AND `S3_BUCKET` is NOT set → validate `PUBLIC_URL` is set, else fatal

- If none of the S3 vars are set → S3 is disabled. `publish_podcast` skips S3 silently.
- If `RSS_FEED_URL` is not set → RSS update is skipped. `publish_podcast` only does S3.
- If neither is configured → `publish_podcast` returns `{ success: false, stages: { s3: { status: 'skipped', reason: 'S3 not configured' }, rss: { status: 'skipped', reason: 'RSS not configured' } }, errorCode: 'no_storage_or_feed_configured' }`.
- If only S3 is configured (no RSS) → `publish_podcast` does S3 upload only; rss stage returns `{ status: 'skipped', reason: 'RSS not configured' }`.
- If only RSS is configured (no S3) → `publish_podcast` does RSS only; s3 stage returns `{ status: 'skipped', reason: 'S3 not configured' }`.

## MCP Tool: `publish_podcast`

### Input Schema

```typescript
{
  // Required: which file to publish (basename, validated in handler)
  outputFilename: string;        // e.g. "episode-42.mp3" — validated in handler
  
  // Required: episode metadata for RSS
  episodeTitle: string;          // Episode title (1-250 chars)
  episodeDescription: string;    // Episode description (plain text only, no HTML tags. 1-5000 chars)
  
  // Optional
  episodeNumber?: number;        // Episode number (positive integer)
  episodeSeason?: number;        // Season number (positive integer)
  episodeGuid?: string;          // Unique identifier. Defaults to outputFilename if omitted.
  episodePublishedAt?: string;   // RFC 3339 timestamp (e.g. 2026-01-15T10:30:00Z). Defaults to now if omitted.
}
```

**Validation:**
- `outputFilename` must be a basename (no `/`, `\`, `..`, or null bytes). Must end in `.mp3` or `.MP3` (case-insensitive). All basename validation happens in the handler (not in Zod) so errors always return the `PublishResult` envelope.
- `episodeTitle` 1–250 chars. `episodeDescription` 1–5000 chars.
- `episodeNumber` and `episodeSeason` must be positive integers if provided.
- `episodePublishedAt` must parse as valid RFC 3339 if provided.

### Output Type (Discriminated Response)

```typescript
interface PublishResult {
  // Overall success: true if at least one stage succeeded
  success: boolean;
  
  // Per-stage status — always present (skipped if not configured)
  stages: {
    s3: StageResult;    // skipped/failed/succeeded
    rss: StageResult;   // skipped/failed/succeeded
  };
  
  // Probe metadata — present if probe succeeded
  fileSizeBytes?: number;
  durationSeconds?: number;
  // Probe failure flags — present when true even if success is true
  probeStatFailed?: boolean;
  probeFFprobeFailed?: boolean;
  // Error code on overall failure — always errorCode (never error)
  errorCode?: string;
}

type StageResult = 
  | { status: 'succeeded'; s3Url?: string; feedUrl?: string }
  | { status: 'failed'; errorCode: string; errorMessage: string }
  | { status: 'skipped'; reason: string };
```

**Success semantics:** `success` is `true` if **any** stage has status `succeeded`. Partial success (e.g. S3 upload succeeds but RSS fails) → `success: true` with per-stage statuses.

**Error codes (stable, machine-parseable):**
- `file_not_found` — file does not exist at the expected path
- `invalid_output_filename` — handler basename validation failed (missing .mp3 extension, contains shell metacharacters)
- `path_traversal_attempted` — realpath check revealed file is outside outputDir (symlink or directory containment failure; distinct from basename validation)
- `s3_config_invalid` — S3 config validation failed at startup (never reaches tool, but documented)
- `s3_upload_failed` — S3 upload threw an error
- `rss_fetch_failed` — GET the feed URL failed (network or non-404 error)
- `rss_create_failed` — creating a new feed failed
- `rss_update_failed` — updating an existing feed failed (ETag retry exhausted)
- `rss_duplicate_guid` — an episode with the same GUID already exists
- `rss_missing_media_url` — RSS stage cannot determine a valid media URL (S3 upload failed AND no `PUBLIC_URL` configured for fallback)
- `probe_stat_failed` — fs.stat failed (file exists but stat returned error)
- `probe_ffprobe_failed` — ffprobe returned non-zero or invalid JSON
- `file_too_large` — file exceeds 500 MB size cap
- `no_storage_or_feed_configured` — neither S3 nor RSS configured

**Probe failure continuation rules:**
- If `fs.stat` fails → `errorCode: 'probe_stat_failed'`, `fileSizeBytes` undefined, `probeStatFailed: true`. If the size cap is also unverified (stat failed) → **reject** with `file_too_large` (never proceed with unbounded `readFile`). If S3 is configured (which reads its own buffer byteLength) and S3 succeeds, RSS can continue with `fileSizeBytes: 0`.
- If `ffprobe` fails → `errorCode: 'probe_ffprobe_failed'`, `durationSeconds` undefined, `probeFFprobeFailed: true`, but upload/RSS **continue** (RSS omits `<itunes:duration>` if unavailable).
- Probe failure does **not** cause stage failure — stages continue normally.
- Probe errors are recorded in `errorCode` only if **no** stage succeeded. If any stage succeeded, `errorCode` is omitted and `success: true`.

### Behavior

```
1. Validate outputFilename as basename ending in .mp3. Must not contain / \ .. or shell metacharacters. Reject otherwise.
2. candidatePath = path.join(outputDir, outputFilename). lstat(candidatePath). If lstat throws (ENOENT, EACCES, EIO, etc.) → errorCode 'file_not_found' (all lstat failures mapped uniformly). If lstat reports a symlink → errorCode 'path_traversal_attempted' (symlinks not allowed). If lstat succeeds but isFile() returns false (e.g., directory named .mp3) → errorCode 'file_not_found'.
3. If lstat passes → realpath(candidatePath). If realpath fails → errorCode 'file_not_found'.
4. Compute relative = path.relative(realpath(outputDir), realpathCandidate). If relative starts with '..' or equals '..' → errorCode 'path_traversal_attempted'. (This is safe: relative cannot be '..' if candidate is inside outputDir.)
5. fs.stat(resolvedPath) → fileSizeBytes. If stat fails → errorCode 'probe_stat_failed', fileSizeBytes undefined, **do not continue with S3 upload** (unbounded `readFile` risk). For RSS-only: if no size, RSS uses 0 for length. If size is known and <= 500 MB, S3 upload continues (upload provides its own byteLength). If size > 500 MB → errorCode 'file_too_large'.
6. ffprobe(resolvedPath) → durationSeconds. Use spawn('ffprobe', ['-v','quiet','-print_format','json','-show_streams',resolvedPath]) (NOT shell interpolation). If ffprobe fails → errorCode 'probe_ffprobe_failed', durationSeconds undefined, continue.
7. If S3 is configured:
   a. Check file size: if `fileSizeBytes > MAX_FILE_SIZE` (500 MB) → reject with `file_too_large`. This prevents OOM when the container has 1G limit.
   b. Upload file to S3 with key = `episodes/<outputFilename>`: `const buffer = await fs.promises.readFile(localPath)`. ContentLength = buffer.byteLength (never 0 for a real file). Return MediaAsset with lengthBytes = buffer.byteLength.
   c. ContentType = 'audio/mpeg'. If upload fails → s3 stageResult.failed with errorCode 's3_upload_failed'. Use S3 SDK upload timeout (default 5 min via timeout config).


8. If RSS is configured:
   a. Determine media URL: if S3 uploaded, use S3 MediaAsset.url; else if `publicUrl` is defined, normalize base URL (strip trailing slash), encode outputFilename as path segment, construct server URL: `${normalizedPublicUrl}/output/${encodeURIComponent(outputFilename)}`. In RSS-only mode the file stays on the local filesystem — `publicUrl` must be the server's own base URL, not a CDN. (The server's `/output/` Express route serves the file.) If no S3 and no publicUrl → rss stageResult.failed with errorCode 'rss_missing_media_url'
   b. Build EpisodeMetadata with title, description, guid (outputFilename), publishedAt (now), episodeNumber, season, durationSeconds
   c. Fetch feed XML from RSS_FEED_URL. Track ETag from response headers.
   d. If 404 → create new RSS feed with podcast metadata + one episode
   e. If 200 → parse existing XML, check for duplicate GUID, append new <item>
   f. PUT updated XML back to RSS_FEED_URL. On 404 → rss stageResult.failed with errorCode 'rss_update_failed' (feed disappeared between GET and PUT). On 200 → PUT with If-None-Match: * for creation (404 case), If-Match: <etag> for update (200 case).
   g. On 412 Precondition Failed → re-fetch (GET), re-merge (append episode), re-PUT. Up to **3 total PUT attempts** with exponential backoff (100ms, 300ms).
   h. If 200 response from GET lacks ETag → PUT without If-Match (last-write-wins). If that PUT fails → `rss_update_failed`.
   i. If PUT succeeds → rss stageResult.succeeded with feedUrl
   j. If creation PUT fails → rss stageResult.failed with errorCode 'rss_create_failed'. If update PUT fails after retries → rss stageResult.failed with errorCode 'rss_update_failed'.
   k. If 409 Conflict on creation PUT (concurrent creators) → re-fetch, merge as update — same retry loop. If update retries exhaust → `rss_update_failed`.
9. Assemble PublishResult:
   - success = (s3.status === 'succeeded') || (rss.status === 'succeeded')
   - errorCode present only if success is false (first-failure code)
   - fileSizeBytes and durationSeconds present only if probe succeeded
```

### RSS Creation Template (exact)

When creating a new feed (404 on GET), produce this exact structure:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
   xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>{PODCAST_TITLE}</title>
    <link>{PODCAST_LINK}</link>
    <description>{PODCAST_DESCRIPTION}</description>
    <language>{PODCAST_LANGUAGE}</language>
    <copyright>Copyright {current year} {PODCAST_AUTHOR}</copyright>
    <managingEditor>{PODCAST_AUTHOR}</managingEditor>
    <webMaster>{PODCAST_AUTHOR}</webMaster>
    <lastBuildDate>{now in RFC 822}</lastBuildDate>
    <pubDate>{now in RFC 822}</pubDate>
    <ttl>60</ttl>
    <dc:creator>{PODCAST_AUTHOR}</dc:creator>
    {# if PODCAST_CATEGORIES:}
    {# for each category:}
    <category>{category}</category>
    {# endfor #}
    {# endif #}
    <itunes:author>{PODCAST_AUTHOR}</itunes:author>
    <itunes:owner>
      <name>{PODCAST_AUTHOR}</name>
    </itunes:owner>
    <itunes:type>episodic</itunes:type>
    {# episode item:}
    <item>
      <title>{episodeTitle}</title>
      <link>{mediaUrl}</link>
      <guid isPermaLink="false">{episodeGuid}</guid>
      <description>{episodeDescription}</description>
      <pubDate>{publishedAt in RFC 822}</pubDate>
      <enclosure url="{mediaUrl}" type="audio/mpeg" length="{fileSizeBytes}"/>
      <content:encoded>{episodeDescription}</content:encoded>
      <itunes:title>{episodeTitle}</itunes:title>
      <itunes:description>{episodeDescription truncated to 4,000 characters at word boundary}</itunes:description>
      <itunes:author>{PODCAST_AUTHOR}</itunes:author>
      {# if episodeNumber:}<itunes:episode>{episodeNumber}</itunes:episode>{# endif #}
      {# if episodeSeason:}<itunes:season>{episodeSeason}</itunes:season>{# endif #}
      {# if durationSeconds:}<itunes:duration>{HH:MM:SS format}</itunes:duration>{# endif #}
      <itunes:explicit>false</itunes:explicit>
    </item>
    {# end episode #}
  </channel>
</rss>
```

Namespaces declared on `<rss>`: `itunes`, `dc`, `content`. Optional iTunes elements (`episode`, `season`, `duration`) are **omitted entirely** when values are absent — never emit placeholder text like "nil".

### RSS Update Behavior (existing feed)

- Parse existing XML. Preserve existing `<channel>` fields (title, link, description, categories) — do NOT overwrite them.
- Check for existing item with matching GUID. If found → return `rss_duplicate_guid` error, do NOT append duplicate.
- Append new `<item>` before `</channel>`.
- Serialize with same XML declaration, same namespace declarations.
- PUT with `If-Match: <current-etag>`. On 412: re-fetch, re-merge, re-PUT (up to 3 total PUT attempts = 2 retries).
- On 404 (feed disappeared between GET and PUT) → `rss_update_failed`.
- If 200 response lacks ETag header → PUT without If-Match (last-write-wins). Document as a limitation.

## Storage Backend Interface

```typescript
interface MediaAsset {
  url: string;           // Publicly reachable URL of the media file
  lengthBytes: number;   // File size in bytes (for RSS enclosure)
  mimeType: string;      // MIME type (e.g. 'audio/mpeg')
}

interface StorageBackend {
  /**
   * Upload a local file to storage.
   * Returns a MediaAsset with a publicly reachable URL.
   */
  upload(localPath: string, key: string): Promise<MediaAsset>;
}
```

### S3 Implementation

Uses `@aws-sdk/client-s3` with `endpoint` override for S3-compatible services (R2, Minio, DigitalOcean Spaces, etc.).

```typescript
class S3StorageBackend implements StorageBackend {
  constructor(config: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl: string;          // Always present — required by constructor
    forcePathStyle?: boolean;
  })
  
  upload(localPath: string, key: string): Promise<MediaAsset>
}
```

- `forcePathStyle` passed to S3 client config when `S3_FORCE_PATH_STYLE=true`.
- Key = `episodes/${filename}` (pass raw filename to AWS SDK; the SDK already percent-encodes key segments for S3 wire protocol).
- When constructing the public URL from `S3_PUBLIC_URL` or `PUBLIC_URL`, encode each path segment: `${normalizedPublicUrl}/episodes/${encodeURIComponent(filename)}`.
- S3_PUBLIC_URL and PUBLIC_URL must be normalized (trailing slash stripped) before URL assembly to prevent double-slash resource paths.
- Upload uses `await fs.promises.readFile(localPath)` → Buffer. Sets `ContentType: audio/mpeg` and `ContentLength: buffer.byteLength` (never 0). Returns `MediaAsset` with `lengthBytes: buffer.byteLength`.
- Returns `{ url: config.publicUrl + '/' + key, lengthBytes, mimeType: 'audio/mpeg' }`.

## Feed Backend Interface

```typescript
interface EpisodeMetadata {
  title: string;
  description: string;         // Plain text only, no HTML
  guid: string;                // Always present (defaults to outputFilename)
  publishedAt: string;     // Always present (defaults to now)
  episodeNumber?: number;
  season?: number;
  durationSeconds?: number;  // Optional — omitted if ffprobe failed
}

interface PodcastMetadata {
  title: string;
  link: string;            // Required for feed creation
  description: string;         // Plain text only, no HTML
  author: string;
  language: string;
  categories: string[];
}

interface FeedBackend {
  /**
   * Add or create an RSS episode entry.
   * If the feed exists at `url`, fetch it, parse, check for duplicate GUID, append an episode, PUT back.
   * If the feed doesn't exist (404), create a new feed with podcast metadata + one episode.
   *
   * PodcastMetadata is injected via constructor; addEpisode receives only the episode-specific data.
   */
  addEpisode(feedUrl: string, episode: EpisodeMetadata, media: MediaAsset): Promise<FeedResult>;
}

interface FeedResult {
  feedUrl: string;
  episodeGuid: string;
}
```

**Ownership model:** `PodcastMetadata` is injected into the `FeedBackend` constructor at startup (from server config). `addEpisode` receives only the per-call episode data. This avoids passing podcast config on every call and keeps the interface clean.

**Error handling:** `addEpisode` throws on failure; the publish handler catches and maps to StageResult.failed with appropriate errorCode. Common failure codes from FeedBackend: `rss_fetch_failed` (GET network error), `rss_create_failed` (XML serialization or creation PUT failed), `rss_update_failed` (update PUT failed, ETag retry exhausted, missing-ETag unconditional PUT failed, or non-2xx/404/412/409 response code), `rss_duplicate_guid` (GUID already exists in feed). Exactly 4 stable codes from FeedBackend.

PUT status mapping: 404→rss_update_failed (update mode), 412→retry loop, 409→retry loop, 403/428/500→rss_update_failed.

### RssFeedBackend (default implementation)

Uses `xml2js` for parsing and building XML. Constructor receives `PodcastMetadata`.

Handles:
- **Feed creation** (404 on GET): generates a valid RSS 2.0 feed using the exact template defined above. PUT with `If-None-Match: *`. On 409 Conflict (concurrent creator succeeded) → re-fetch the existing feed, append as update instead.
- **Feed update** (200 on GET): parses existing XML, checks for duplicate GUID, appends `<item>`, serializes back with namespace preservation (adds missing itunes/dc/content declarations to root if needed).
- **Concurrency safety**: uses ETag/If-Match with up to 3 total PUT attempts (2 retries, exponential backoff: 100ms, 300ms). On 412, re-fetch, re-merge, re-PUT. If 3 attempts exhausted → throws `rss_update_failed`.
- **XML escaping**: the xml2js `Builder` escapes raw string values during serialization — do NOT pre-escape strings before passing to the Builder (that would cause double escaping). Description must be plain text only.
- **Missing ETag on GET**: PUT without If-Match (last-write-wins). If that PUT fails → `rss_update_failed`. Duplicate detection is best-effort on non-ETag hosts.
- **XXE protection**: xml2js 0.6 does not support `whitelist` or `maxDepth`. Instead, feed XML bodies are validated against a 2 MB size limit before parsing. Feed URLs are operator-configured (not user-supplied), so XXE risk is low.
- **Timeouts**: ffprobe 30s, feed HTTP 10s, S3 upload 5 min.

RSS 2.0 fields populated in `<item>`:
- `<title>` — episode title
- `<link>` — media URL
- `<guid>` — episode GUID (isPermaLink="false")
- `<description>` — episode description
- `<pubDate>` — formatted to RFC 822
- `<enclosure>` — URL, type="audio/mpeg", length (file size)
- `<content:encoded>` — episode description
- `<itunes:title>` — same as title
- `<itunes:description>` — same as description (truncated to 4000 chars if longer)
- `<itunes:author>` — podcast author
- `<itunes:episode>` — episode number (if provided)
- `<itunes:season>` — season number (if provided)
- `<itunes:duration>` — duration in HH:MM:SS format
- `<itunes:explicit>` — false

## Error Handling (complete)

| Scenario | Response |
|---|---|
| File doesn't exist on disk | `{ success: false, stages: { s3: { status: 'skipped', reason: '...' }, rss: { status: 'skipped', reason: '...' } }, errorCode: 'file_not_found' }` |
| Directory named .mp3 on disk | `{ success: false, stages: { s3: { status: 'skipped', reason: '...' }, rss: { status: 'skipped', reason: '...' } }, errorCode: 'file_not_found' }` (lstat.isFile() returns false) |
| `outputFilename` contains `../` or `/` | `{ success: false, stages: { s3: { status: 'skipped', reason: '...' }, rss: { status: 'skipped', reason: '...' } }, errorCode: 'invalid_output_filename' }` |
| S3 not configured, RSS not configured | `{ success: false, stages: { s3: { status: 'skipped', reason: 'S3 not configured' }, rss: { status: 'skipped', reason: 'RSS not configured' } }, errorCode: 'no_storage_or_feed_configured' }` — short-circuits before probing (no stat, no ffprobe).
| S3 upload fails, RSS skipped | `{ success: false, stages: { s3: { status: 'failed', errorCode: 's3_upload_failed', errorMessage: '...' }, rss: { status: 'skipped', reason: 'RSS not configured' } }, errorCode: 's3_upload_failed' }` |
| S3 succeeds, RSS fails | `{ success: true, stages: { s3: { status: 'succeeded', s3Url }, rss: { status: 'failed', errorCode: 'rss_update_failed', errorMessage: '...' } } }` |
| RSS fetch fails (network), S3 skipped | `{ success: false, stages: { s3: { status: 'skipped', reason: 'S3 not configured' }, rss: { status: 'failed', errorCode: 'rss_fetch_failed', errorMessage: '...' } }, errorCode: 'rss_fetch_failed' }` |
| RSS fetch fails, S3 succeeds | `{ success: true, stages: { s3: { status: 'succeeded', s3Url }, rss: { status: 'failed', errorCode: 'rss_fetch_failed', errorMessage: '...' } } }` |
| Duplicate GUID, S3 skipped | `{ success: false, stages: { s3: { status: 'skipped', reason: 'S3 not configured' }, rss: { status: 'failed', errorCode: 'rss_duplicate_guid', errorMessage: 'episode with this GUID already exists' } }, errorCode: 'rss_duplicate_guid' }` |
| Neither stage succeeds (both failed) | `{ success: false, stages: { s3: { status: 'failed', errorCode: 's3_upload_failed', errorMessage: '...' }, rss: { status: 'failed', errorCode: 'rss_update_failed', errorMessage: '...' } }, errorCode: 's3_upload_failed' }` |
| Probe stat failed, both stages succeed | `{ success: true, stages: { s3: { status: 'succeeded', s3Url }, rss: { status: 'succeeded', feedUrl } }, durationSeconds: 123.4, probeStatFailed: true }` |
| Probe ffprobe failed, both stages succeed | `{ success: true, stages: { s3: { status: 'succeeded', s3Url }, rss: { status: 'succeeded', feedUrl } }, fileSizeBytes: 12345, probeFFprobeFailed: true }` |
| Creation PUT fails, S3 succeeds | `{ success: true, stages: { s3: { status: 'succeeded', s3Url }, rss: { status: 'failed', errorCode: 'rss_create_failed', errorMessage: '...' } } }` |
| Creation PUT fails, S3 fails | `{ success: false, stages: { s3: { status: 'failed', errorCode: 's3_upload_failed', errorMessage: '...' }, rss: { status: 'failed', errorCode: 'rss_create_failed', errorMessage: '...' } }, errorCode: 's3_upload_failed' }` |
| S3 fails, RSS fails without PUBLIC_URL (dual-mode) | `{ success: false, stages: { s3: { status: 'failed', errorCode: 's3_upload_failed', errorMessage: '...' }, rss: { status: 'failed', errorCode: 'rss_missing_media_url', errorMessage: '...' } }, errorCode: 's3_upload_failed' }` |

**errorCode semantics:** `errorCode` is present only when `success` is `false`. When `success` is `true` (partial success — one stage succeeded, another failed), `errorCode` is omitted. The `errorCode` value is always the first-failure code. No `errorCode` value is ever `undefined` in JSON output. All stage objects are always present (never `null`). All stage failure objects use `errorCode` + `errorMessage` (never `error`).

**Probe status fields:** `probeStatFailed` and `probeFFprobeFailed` boolean flags are included in `PublishResult` when true, even if `success: true`. This lets clients distinguish a real `lengthBytes: 0` from a stat failure (RSS enclosure `length="0"`).

**Precedence:** If no S3 and no RSS are configured → short-circuit immediately with `no_storage_or_feed_configured`, no probing. If only one backend is configured → probe continues (stat + ffprobe may still be useful for the RSS enclosure length). If one backend fails and the other succeeds → `success: true`, no `errorCode`. If both fail → precedence order: probe error (if any probe failed) takes precedence over stage error (s3 before rss). This means: if stat failed AND s3 failed, `errorCode` is `probe_stat_failed`, not `s3_upload_failed`. If no probe failed but both stages failed, `errorCode` is `s3_upload_failed` (s3 before rss).

The tool handler **never throws** — all errors are returned in the response object so the MCP client can decide how to handle them. (The MCP SDK validates input against the registered schema before the handler runs; schema validation failures are handled by the SDK and do not reach the handler.) Basename validation (`.mp3` extension, path traversal) is done in the handler, not in the Zod schema, so all errors flow through the `PublishResult` envelope.

## Testing Strategy

1. **S3 storage tests** — mock `@aws-sdk/client-s3` with stubbed S3Client. Verify:
   - Upload constructs correct PutObjectCommand with the right endpoint/region/forcePathStyle
   - Returns MediaAsset with correct URL, size, mimeType
   - contentType is 'audio/mpeg'
   - S3 config validation: all-or-none check

2. **RSS feed tests** — mock HTTP GET/PUT with ETag support. Verify:
   - New feed creation produces valid RSS 2.0 XML (use structural comparison — parse both sides, compare trees; whitespace/attribute order may differ between xml2js create and update paths)
   - Feed update preserves existing channel fields, appends new item before `</channel>`
   - Duplicate GUID detection works
   - ETag retry loop: 412 triggers re-fetch + re-merge, max 3 total PUT attempts (2 retries)
   - Non-404 GET (e.g. 500) returns fetch error, not "create new"
   - XML escaping of special characters in title/description
   - Namespace preservation on update (itunes, dc, content)
   - Creation PUT failure → errorCode 'rss_create_failed'
   - Update PUT failure → errorCode 'rss_update_failed'
   - RFC 822 date formatting

3. **Publish tool tests** — mock both StorageBackend and FeedBackend. Verify:
   - Both S3 and RSS work together (full success)
   - S3-only mode (no RSS configured) — rss stage is skipped
   - RSS-only mode (no S3 configured) — s3 stage is skipped, media URL falls back to `/output/` route
   - Neither configured → appropriate error
   - Partial failure (S3 succeeds, RSS fails) → `success: true` with per-stage statuses, no `errorCode`
   - Partial failure (S3 fails, RSS succeeds) → `success: true` with per-stage statuses, no `errorCode`
   - Partial failure (S3 fails, RSS skipped) → `success: false` with `errorCode: 's3_upload_failed'`
   - Path traversal rejection: `../../etc/passwd.mp3` → `invalid_output_filename` (basename contains `..` or `/` or `\`)
   - Symlink rejection: symlink in output dir → `path_traversal_attempted` (lstat isSymbolicLink check)
   - realpath check: file outside outputDir → `path_traversal_attempted`
   - fs.stat failure → `fileSizeBytes` undefined, S3 determines size from file, rss uses 0 for length
   - ffprobe failure → `durationSeconds` undefined, RSS omits `<itunes:duration>`
   - Episode metadata validation: negative episodeNumber → validation error
   - Title/description char limits enforced
   - `path.join` used for candidate path (not string concatenation)

## Concurrency Model

The server creates a fresh MCP server per request but Express handles requests in the same Node.js process. Two concurrent `publish_podcast` calls hitting the same RSS feed will both GET the feed, get the same ETag, and one PUT will get 412. The retry loop handles this: the retrying caller re-fetches the now-updated feed and merges correctly. In practice, the second retry will see the first episode and append the second — no data loss.

**Feed creation (404 → PUT with If-None-Match: *)** is also protected: two concurrent creators, only the first succeeds (201 or 200). The second gets 409 Conflict, re-fetches the existing feed, and appends as an update instead — no data loss.

If a 200 response from GET lacks an ETag header, the PUT proceeds without If-Match (last-write-wins). If that PUT fails → `rss_update_failed`. **Duplicate GUID detection only works on ETag-supporting hosts.** On non-ETag hosts, concurrent identical GUIDs may produce duplicate items — document as a limitation.

For deployments with multiple replicas (multiple container processes), the ETag/If-Match + If-None-Match pattern is the correct synchronization mechanism. No external lock needed.

## Dependency Changes

### package.json (devDependencies and dependencies)

Add to **dependencies**:
- `@aws-sdk/client-s3` — S3-compatible client (v3, modular)
- `xml2js` — XML parsing and serialization for RSS

Add to **devDependencies**:
- `@types/xml2js` — TypeScript types for xml2js

(No other devDependencies change needed beyond what the test framework already provides.)

### docker-compose.yml

Add S3 env vars to the environment block (read from `.env`):
```yaml
environment:
  - GOOGLE_API_KEY=${GOOGLE_API_KEY}
  - OUTPUT_DIR=/output
  - TEMP_DIR=/tmp/podcast-gen
  - PORT=3000
  - S3_ENDPOINT=${S3_ENDPOINT}
  - S3_REGION=${S3_REGION}
  - S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
  - S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
  - S3_BUCKET=${S3_BUCKET}
  - S3_PUBLIC_URL=${S3_PUBLIC_URL}
  - S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE}
  - RSS_FEED_URL=${RSS_FEED_URL}
  - PODCAST_TITLE=${PODCAST_TITLE}
  - PODCAST_DESCRIPTION=${PODCAST_DESCRIPTION}
  - PODCAST_AUTHOR=${PODCAST_AUTHOR}
  - PODCAST_LANGUAGE=${PODCAST_LANGUAGE}
  - PODCAST_CATEGORIES=${PODCAST_CATEGORIES}
  - PODCAST_LINK=${PODCAST_LINK}
  - PUBLIC_URL=${PUBLIC_URL}
```

### .env.example

Add S3 variables (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_URL, S3_FORCE_PATH_STYLE), RSS variables (RSS_FEED_URL, PODCAST_TITLE, PODCAST_DESCRIPTION, PODCAST_LINK, PODCAST_AUTHOR, PODCAST_LANGUAGE, PODCAST_CATEGORIES), and `PUBLIC_URL` (required when RSS is configured without S3 for public enclosure URLs). Add comments explaining each variable.

## Implementation Order

1. `src/storage/storage-types.ts` — `MediaAsset` type + `StorageBackend` interface + S3 config validation
2. `src/storage/s3-storage.ts` — S3 implementation
3. `src/feed/feed-types.ts` — `FeedBackend` interface + `EpisodeMetadata` + `PublishResult` types
4. `src/feed/rss-feed.ts` — RSS implementation (create + update + ETag retry)
5. `src/tools/publish-podcast.ts` — Zod schema + handler (probe stats, dispatch to backends, assemble response)
6. `src/index.ts` — wire up, env var reading, S3 config validation, register both tools
7. Tests
8. `package.json`, `docker-compose.yml`, `.env.example`, `README.md`

## Residual Risks

- **RSS PUT authentication**: some self-hosted RSS hosts require auth (basic auth, API key in header). The current design assumes simple PUT. Document this as a limitation — if the host needs auth, the operator must configure it (e.g. via a proxy or the feed URL containing credentials).
- **S3 object ACL**: uploads are private by default (depends on bucket policy). The operator must ensure the bucket allows public read, or configure a CDN.
- **ETag precision**: some S3-compatible backends (Minio older versions) don't return proper ETags. The retry loop degrades to last-write-wins in that case — documented as a limitation. Duplicate GUID detection only works on ETag-supporting hosts.
- **TOCTOU on path checks**: `lstat → realpath → stat → readFile` are separate syscalls. For single-process Express this is acceptable (no concurrent file swaps), but document the risk.
- **Size limit**: files > 500 MB are rejected before `readFile`. Upload timeout: S3 5 min, ffprobe 30s, feed HTTP 10s.
- **Test matching**: use structural XML comparison (parse+compare trees), not byte-exact, because xml2js insertion order differs between create and update paths.
- **pubDate timezone**: format to RFC 822 in UTC. Use `new Date().toISOString()` then convert.
- **Truncation**: `itunes:description` truncated to 4,000 characters (not bytes) at a word boundary.
