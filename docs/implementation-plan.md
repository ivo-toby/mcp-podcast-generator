# Implementation Plan: S3 + RSS Publish

Based on `docs/SPEC-upload-publish.md` and `docs/research-api-integration.md`.

---

## Task List

### Phase 1: Storage Backend

#### T1: `src/storage/storage-types.ts`
- Define `MediaAsset` interface: `{ url, lengthBytes, mimeType }`
- Define `StorageBackend` interface: `{ upload(localPath, key): Promise<MediaAsset> }`
- Define `S3Config` interface with 5 required vars (endpoint, accessKeyId, secretAccessKey, bucket, publicUrl) plus optional region and forcePathStyle
- Implement `validateS3Config()`:
  - Check the 5 required vars. If none set → return `{ config: null, enabled: false }`
  - If any required var set → validate all 5 are present, else throw fatal
  - Validate `endpoint` is a valid URL via `new URL(endpoint)` (throw if not)
  - Normalize `publicUrl` by stripping trailing slashes: `publicUrl.replace(/\/+$/, '')`
  - Region defaults to `us-east-1` when absent. `S3_FORCE_PATH_STYLE` is separate (only `'true'` enables it; alone does NOT enable S3)
  - Return `{ config, enabled: true }` with parsed values

#### T2: `src/storage/s3-storage.ts`
- Implement `S3StorageBackend` class
- Constructor: create `S3Client` with endpoint, region, credentials, forcePathStyle
- `upload(localPath, key)`:
  - `const buffer = await fs.promises.readFile(localPath)` (async, avoids stream retry issue #5479)
  - `client.send(PutObjectCommand)` with Body=buffer, ContentType=audio/mpeg, ContentLength: buffer.byteLength. Timeout via `NodeHttpHandler({ requestTimeout: 300_000 })` in the `S3Client` config (PutObjectCommand has no built-in timeout).
  - Return `{ url: config.publicUrl + '/' + key, lengthBytes: buffer.byteLength, mimeType: 'audio/mpeg' }` (note: `config.publicUrl` is normalized in T1 to strip trailing slashes, so `+ '/' + key` produces correct single-slash URLs)
- Log upload progress: key, bucket, status, bytes — **never** log credentials or secrets

#### T3: `src/storage/index.ts`
- Re-export `MediaAsset`, `StorageBackend`, `S3StorageBackend`, `S3Config`, `validateS3Config`

### Phase 2: Feed Backend

#### T4: `src/feed/feed-types.ts`
- Define `EpisodeMetadata` interface (title, description, guid, publishedAt, episodeNumber?, season?, durationSeconds?)
- Define `PodcastMetadata` interface (title, link, description, author, language, categories)
- Define `FeedBackend` interface: `addEpisode(feedUrl, episode, media): Promise<FeedResult>`
- Define `FeedResult` interface: `{ feedUrl, episodeGuid }`
- Define `StageResult` type: succeeded/failed/skipped union
- Define `PublishResult` interface: `{ success, stages, fileSizeBytes?, durationSeconds?, errorCode? }`

#### T5: `src/feed/rss-feed.ts`
- Implement `RssFeedBackend` class
- Constructor: receives `PodcastMetadata`
- `addEpisode(feedUrl, episode, media): Promise<FeedResult>`:
  - Fetch feed with `fetch()`. If 404 → create. If 200 → parse + update.
  - Error handling: throw `new Error(message)` with `.code` set to one of (`rss_fetch_failed`, `rss_create_failed`, `rss_update_failed`, `rss_duplicate_guid`). The handler checks `error.code`, not string-prefix — this survives message refactors.
- `createFeed(episode, media)`:
  - Build RSS 2.0 object with namespace declarations (`xmlns:itunes`, `xmlns:dc`, `xmlns:content`)
  - Use xml2js `Builder` with shared config: `renderOpts: { pretty: true, indent: '  ' }`, `xmldec: { version: '1.0', encoding: 'UTF-8' }` (omit standalone property — setting standalone to false produces `standalone="no"` in output, which contradicts the exact template requirement)
  - Populate channel: title, link, description, language, copyright, managingEditor, webMaster, lastBuildDate, pubDate, ttl, dc:creator, categories
  - Populate itunes: author, owner (with name), type=episodic
  - Populate episode item: title, link, guid, description, pubDate, enclosure, content:encoded, itunes:title, itunes:description (truncated to 4,000 chars per iTunes podcast spec), itunes:author, itunes:episode?, itunes:season?, itunes:duration? (HH:MM:SS), itunes:explicit
  - Return XML string
- `updateFeed(existingXml, episode, media)`:
  - `parseStringPromise(existingXml)` → object
  - Navigate to `result.rss.channel[0]` — parsed channel object
  - Navigate to `result.rss.channel[0].item` — ensure array with `channel.item ??= []` (xml2js omits key when no <item> exists)
  - Check for duplicate GUID: `const node = item.guid?.[0]; const guid = typeof node === 'string' ? node : node?._; compare against requested GUID`. Test both plain text GUIDs (`<guid>value</guid>`) and attributed GUIDs (`<guid isPermaLink="false">value</guid>`).
  - If duplicate → throw `rss_duplicate_guid`
  - Build new item with namespaced keys
  - Push to `result.rss.channel[0].item` array
  - **Namespace repair**: ensure `result.rss.$` has `xmlns:itunes`, `xmlns:dc`, `xmlns:content` declarations; add missing ones
  - `Builder.buildObject(result)` → XML string (uses same shared config as createFeed)
  - Return XML
- `putWithRetry(feedUrl, xml, etag, isCreate, episode, media)`:
  - `let mode: 'create' | 'update' = isCreate ? 'create' : 'update'`
  - Loop up to 2 retries with exponential backoff (100, 300 ms) — 3 total PUT attempts. Feed HTTP GET/PUT uses `fetch()` with `AbortSignal.timeout(10_000)`.
  - PUT with `Content-Type: application/rss+xml` header; `If-Match: etag` (mode === 'update') or `If-None-Match: *` (mode === 'create')
  - On 412 → re-fetch (GET). If GET 200 → mode = 'update' with new ETag, re-parse, re-merge (append episode), re-serialize, re-PUT. If GET 404 → if mode was 'update', feed was concurrently deleted → throw `rss_update_failed`; if mode was 'create', remain in create mode, re-serialize, PUT with If-None-Match: *
  - On 409 → re-fetch (GET). If GET 200 → mode = 'update' with new ETag, re-parse, merge as update, re-serialize, re-PUT. If GET 404 → if mode was 'update', throw `rss_update_failed`; if mode was 'create', remain in create mode, re-serialize, PUT with If-None-Match: *
  - On any 404 → throw `rss_create_failed` if mode === 'create', else throw `rss_update_failed`
  - On any 2xx → return XML
  - On failure after retries → throw `rss_create_failed` (mode === 'create') or `rss_update_failed` (mode === 'update')
  - Tests: initial create PUT sends If-None-Match: *; initial update PUT sends If-Match: etag; 409 GET 200 transitions to mode 'update'; 412 GET 404 in update mode → rss_update_failed; 412 GET 404 in create mode → stays create mode
- Helper functions: `toRFC822()`, `formatDuration()` — NO manual xmlEscape; xml2js Builder already escapes text content. Pass raw strings to Builder. `toRFC822()` formats in UTC.
- `parseStringPromise` called with `{ whitelist: [], maxDepth: 100 }` for XXE protection.

#### T6: `src/feed/index.ts`
- Re-export `FeedBackend`, `EpisodeMetadata`, `PodcastMetadata`, `FeedResult`, `StageResult`, `PublishResult`, `RssFeedBackend`

### Phase 3: Publish Tool

#### T7: `src/tools/publish-podcast.ts`
- Export `PublishPodcastInput` Zod schema (structurally permissive — MCP SDK validates before handler runs):
  - outputFilename: string (bare `z.string()` — handler validates .mp3 suffix, path traversal, shell metacharacters)
  - episodeTitle: string (1-250 chars)
  - episodeDescription: string (1-5000 chars)
  - episodeNumber?: positive integer
  - episodeSeason?: positive integer
  - episodeGuid?: string
  - episodePublishedAt?: RFC 3339 string
- Export `createPublishHandler(storage, feed, outputDir, publishPublicUrl)`: `publishPublicUrl` is the OPTIONAL RSS fallback URL from `process.env.PUBLIC_URL` (no default to localhost — preserve existing `config.publicUrl` for `generate_podcast` only)
  - Returns async function that takes input
  - **Short-circuit**: if no S3 and no RSS configured → return `no_storage_or_feed_configured` immediately, skip probing
  - Validate filename in handler: must end in `.mp3` or `.MP3` (case-insensitive), no `/` `\` `..` null bytes → reject with `invalid_output_filename`. MCP SDK validates the registered schema first (structurally permissive). Basename validation is separate from realpath traversal (`path_traversal_attempted`).
  - **Size check**: if `fileSizeBytes > 500 * 1024 * 1024` → reject with `file_too_large`. If `stat` fails (size unknown) → reject with `file_too_large` — never proceed with unbounded `readFile`.
  - `lstat(candidatePath)` → if `isSymbolicLink()` return true → reject with `path_traversal_attempted`. If `isFile()` returns false (directory, device, etc.) → reject with `file_not_found`.
  - `realpath(candidatePath)` check → reject symlinks + traversal
  - `stat()` → fileSizeBytes (if fails, errorCode=probe_stat_failed; RSS uses fileSizeBytes or 0, S3 uses `buffer.byteLength` from upload)
  - `spawn('ffprobe', [...])` → durationSeconds (if fails, errorCode=probe_ffprobe_failed; timeout via `child.kill('SIGTERM')` after 30s)
  - Construct fallback MediaAsset only when `publishPublicUrl` is defined: normalize base URL (strip trailing slash), encode filename as path segment, construct URL: `{ url: `${normalizedPublicUrl}/output/${encodeURIComponent(filename)}`, lengthBytes: fileSizeBytes ?? 0, mimeType: 'audio/mpeg' }`. When S3 upload succeeds, replace fallback with S3 asset. When S3 upload fails AND publishPublicUrl is undefined, RSS stage has no valid MediaAsset → rss stageResult.failed with errorCode `rss_missing_media_url`
  - S3 upload key: `episodes/${filename}` (pass raw key to AWS SDK; SDK already encodes key segments on the wire). Returned URL = `${normalizedPublicUrl}/episodes/${encodeURIComponent(filename)}`.
  - Assemble PublishResult:
    - success = s3.succeeded || rss.succeeded
    - errorCode precedence: if any probe failed and no stage succeeded, probe error takes precedence over stage errors; otherwise first-failure stage error
    - fileSizeBytes/durationSeconds only if probe succeeded
    - probeStatFailed/probeFFprobeFailed flags when probe fails, even if success is true
    - default episodeGuid to outputFilename, publishedAt to now (UTC)
  - Never throw — return structured error responses
- Export `skipResult(reason)`, `buildResult()` helper functions

### Phase 4: Integration

#### T8: `src/index.ts`
- Read S3 env vars at module scope
- Call `validateS3Config()` — if enabled, create `S3StorageBackend` instance
- Read RSS env vars at module scope
- If `RSS_FEED_URL` set → validate PODCAST_TITLE, PODCAST_DESCRIPTION, PODCAST_LINK, PODCAST_AUTHOR → create `RssFeedBackend`
- Default `PODCAST_LANGUAGE` to `en-us`, `PODCAST_CATEGORIES` to `['Technology']` (comma-separated input → split/trim → array)
- Fatal error if RSS configured but metadata missing
- If `RSS_FEED_URL` set AND `S3_BUCKET` is NOT set → validate `PUBLIC_URL` is set, else fatal (needed for RSS-only enclosure URLs)
- If `PUBLIC_URL` is used for RSS-only mode, reject `localhost`, `127.0.0.1`, or `::1` (any port) as a public enclosure URL
- In `createMcpServer()`, register `publish_podcast` tool:
  - Input schema matches `PublishPodcastInput` shape
  - Handler: static import of `createPublishHandler`, call with configured backends (no circular dependency risk)
  - Return structured JSON response
- Fatal error if partial S3 config detected
- **S3 config validation algorithm**: check if ANY of the 5 required S3 vars is set (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`); if yes, all 5 must be present or fatal; `S3_REGION` is optional and defaults to `us-east-1` only when absent; `S3_FORCE_PATH_STYLE` is a separate boolean var (parsed strictly: only 'true' enables it, everything else is false); setting only `S3_FORCE_PATH_STYLE` does NOT count as "S3 configured"; validate S3_ENDPOINT as valid URL via `new URL(endpoint)`

#### T9: `tests/index.config.test.ts`
- RSS configured without PODCAST_TITLE → startup error
- RSS configured without PODCAST_DESCRIPTION → startup error
- RSS configured without PODCAST_LINK → startup error
- RSS configured without PODCAST_AUTHOR → startup error
- RSS configured without S3 → PUBLIC_URL required, absent → startup error
- RSS configured with S3 → PUBLIC_URL optional
- PODCAST_CATEGORIES comma-separated → split/trim → array; missing → defaults to ['Technology']
- PODCAST_LANGUAGE missing → defaults to 'en-us'
- S3 partial config (3 of 5 vars) → startup error

#### T10: `package.json` and config files
- Add `@aws-sdk/client-s3` to dependencies
- Add `xml2js` to dependencies
- Add `@types/xml2js` to devDependencies
- Regenerate `package-lock.json` to reflect new dependencies
- Add `PUBLIC_URL` to `.env.example` and docker-compose.yml environment block

### Phase 5: Config & Docs

#### T11: `.env.example`
- Add S3 env vars (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_URL, S3_FORCE_PATH_STYLE)
- Add RSS env vars (RSS_FEED_URL, PODCAST_TITLE, PODCAST_DESCRIPTION, PODCAST_LINK, PODCAST_AUTHOR, PODCAST_LANGUAGE, PODCAST_CATEGORIES)
- Add PUBLIC_URL env var — base URL for RSS-only fallback enclosures (required when RSS configured without S3)
- Keep existing vars unchanged

#### T12: `docker-compose.yml`
- Add S3 and RSS env vars to environment block
- Add PUBLIC_URL to environment block (required for RSS-only enclosure URLs)
- Keep existing vars unchanged

#### T13: `README.md`
- Document `publish_podcast` tool
- Document new env vars (S3 + RSS)
- Document architecture (storage/feed abstraction)
- Document concurrency model (ETag/If-Match)
- Update dependency list
- Document residual limitations: RSS authentication (basic auth/API key not supported, document as limitation), S3 public-read policy (bucket must allow public read or configure CDN), missing/imprecise ETags degrades PUT to last-write-wins (document as limitation), PUBLIC_URL required for RSS-only publishing (document requirement)

#### T14: `tests/storage/s3-storage.test.ts`
- Upload constructs correct PutObjectCommand with right endpoint/region/forcePathStyle
- Returns MediaAsset with correct URL, size, mimeType
- contentType is 'audio/mpeg'
- Upload uses `await fs.promises.readFile()` → Buffer (not stream) — verifies retry-safety
- `ContentLength === buffer.byteLength` (not stat size)
- Upload returns `lengthBytes: buffer.byteLength`
- S3 config validation: 5 required vars, partial throws, absent returns null
- Region defaults to us-east-1 when S3_REGION absent but other S3 vars present
- S3_FORCE_PATH_STYLE='true' enables path style; setting only S3_FORCE_PATH_STYLE does NOT enable S3
- S3_ENDPOINT must be valid URL; invalid URL throws
- S3_PUBLIC_URL trailing slash stripped before URL assembly
- S3 PutObject.Key is raw filename (SDK encodes on wire); returned MediaAsset URL uses encodeURIComponent(filename)
- RSS-only without PUBLIC_URL configured → startup validation error

#### T15: `tests/feed/rss-feed.test.ts`
- Missing ETag on GET → unconditional PUT; if PUT fails → rss_update_failed (duplicate detection is best-effort on non-ETag hosts)
- New feed creation produces valid RSS 2.0 XML (use structural comparison — parse and compare trees, not byte-exact)
- Feed update preserves existing channel fields, appends new item before </channel>
- Duplicate GUID detection works
- ETag retry loop: 412 triggers re-fetch + re-merge, max 2 retries (3 total PUTs)
- 409 Conflict handling: re-fetch (GET). If 200 → switch to update mode with new ETag, merge as update, PUT with If-Match. If 404 → if mode was 'update', throw rss_update_failed; if mode was 'create', remain in create mode, PUT with If-None-Match: *
- 412 Precondition Failed: re-fetch (GET). If 200 → switch to update mode with new ETag, re-merge, PUT with If-Match. If 404 → if mode was 'update', throw rss_update_failed; if mode was 'create', remain in create mode, PUT with If-None-Match: *
- 404 handling: feed disappeared between GET and PUT → rss_update_failed
- Non-404 GET (e.g. 500) returns fetch error, not "create new"
- XML escaping of special characters in title/description (one level, no double escaping)
- Namespace preservation on update (itunes, dc, content)
- Namespace repair: starting from namespace-free RSS 2.0 feed, update adds missing xmlns declarations
- RFC 822 date formatting
- Creation PUT failure → errorCode 'rss_create_failed'
- Update PUT failure → errorCode 'rss_update_failed'
- Builder buildObject failure in create mode → `rss_create_failed`; in update mode → `rss_update_failed`
- Creation PUT 404 → rss_create_failed (not rss_update_failed)
- Update PUT 404 → rss_update_failed
- 412 in update mode + GET 404 → rss_update_failed (feed was concurrently deleted during update, not re-created)
- 412 in create mode + GET 404 → stay in create mode (feed still doesn't exist)
- 409 in update mode + GET 404 → rss_update_failed; 409 in create mode + GET 404 → stay in create mode
- Empty feed update: feed with zero items (`channel.item` absent from parsed object) → `??= []` before appending
- iTunes description truncation to 4,000 chars (not bytes) at word boundary
- XXE protection: parseStringPromise called with `{ whitelist: [], maxDepth: 100 }`

#### T16: `tests/tools/publish-podcast.test.ts`
- Both S3 and RSS work together (full success)
- S3-only mode (no RSS configured) — rss stage is skipped
- RSS-only mode (no S3 configured) — s3 stage is skipped, media URL falls back to `/output/` route
- Neither configured → appropriate error (no_storage_or_feed_configured), short-circuits before probing
- RSS-only mode without PUBLIC_URL configured → startup fatal validation error
- S3 succeeds, RSS fails → `success: true` with per-stage statuses, no `errorCode`
- S3 fails, RSS succeeds with fallback URL → `success: true` (RSS uses fallback media URL)
- S3 fails, RSS fails without PUBLIC_URL → `success: false` with errorCode `s3_upload_failed` (S3-first precedence, both stages failed)
- URL normalization: base URL with trailing slash produces correct single-slash assembly; special chars in filename encoded via encodeURIComponent
- Partial failure (S3 fails, RSS succeeds) → `success: true` with per-stage statuses, no `errorCode`
- Partial failure (S3 fails, RSS skipped) → `success: false` with `errorCode: 's3_upload_failed'`
- file_not_found: non-existent filename → rejected before probing
- Path traversal rejection: `../../etc/passwd.mp3` → `invalid_output_filename` (basename contains `..` or `/` or `\`)
- Symlink in output dir → rejected with `path_traversal_attempted`
- realpath check: file outside outputDir → rejected
- fs.stat failure → `fileSizeBytes` undefined, S3 uses `buffer.byteLength` from upload, rss uses 0 for length
- ffprobe failure → `durationSeconds` undefined, RSS omits `<itunes:duration>`
- **Size check**: file > 500 MB → rejected with `file_too_large` (not `invalid_output_filename`)
- **Unknown size** (stat fails): reject with `file_too_large` — never proceed with unbounded `readFile`
- **Zod/SDK-validated fields** (these pass through the SDK, not the handler): negative episodeNumber → validation error; `episodePublishedAt` not RFC 3339 → validation error; title/description char limits (1-250 for title, 1-5000 for description; boundary values accepted, 0 and 251/5001 rejected). Test these in a separate schema-level test, not in the handler test.
- `episodePublishedAt` Zod shape: `.datetime()` or `.refine()` accepting RFC 3339 — specify in schema tests.
- URL normalization: base URL with trailing slash stripped before assembly; filename with special chars (spaces, unicode) encoded via encodeURIComponent
- `path.join` used for candidate path (not string concatenation)
- GUID defaults to outputFilename
- publishedAt defaults to now
- Concurrent distinct GUIDs on same feed → both appended correctly
- Concurrent identical GUIDs on ETag-supporting hosts → duplicate detection catches second; on non-ETag hosts this is best-effort

---

## Timeout Mechanisms

- **ffprobe**: spawn with `child.kill('SIGTERM')` after 30 seconds
- **Feed HTTP** (GET/PUT): `fetch()` with `AbortSignal.timeout(10_000)`
- **S3 upload**: `PutObjectCommand` via `NodeHttpHandler({ requestTimeout: 300_000 })` in the `S3Client` config
- **readFile**: `fs.promises.readFile(path, { signal: AbortSignal.timeout(30_000) })`
- All timeouts use `AbortSignal` / `kill()` — no bare `setTimeout` that could leak handles.

## Logging Safety

- Upload progress log fields: key, bucket, status, bytes — **never** log credentials or secrets.

## XML Comparison for Tests

- Use structural XML comparison (parse both sides, compare trees) instead of byte-exact matching. xml2js Builder insertion order differs between create (fresh object) and update (mutated parsed object) paths, so whitespace/attribute order will differ.

---

## Verification

After implementation:
1. `npm run build` — TypeScript compilation must pass
2. `npm test` — all tests pass, coverage for new code
3. Manual test: run server, call `publish_podcast` with mock S3 (local Minio) + mock RSS (stateful HTTP server supporting GET/PUT/ETag/412/409)
4. Regenerate `package-lock.json` — ensure it reflects new dependencies

---

## Dependencies

| Package | Type | Version |
|---|---|---|
| `@aws-sdk/client-s3` | dependency | ^3.600.0 |
| `xml2js` | dependency | ^0.6.0 |
| `@types/xml2js` | devDependency | ^0.4.0 |

---

## Notes

- All new files follow existing code patterns (childLogger, zod schemas, pino logging)
- The `publish_podcast` tool handler uses static import — no circular dependency risk
- S3 upload uses `fs.promises.readFile()` → Buffer (never raw streaming)
- xml2js handles colon-prefixed tag names natively — no manual xmlEscape needed; Builder already escapes text content. Description must be plain text only.
- xml2js parsed object navigation: `result.rss.channel[0]` for channel. GUID: `const node = guid?.[0]; const value = typeof node === 'string' ? node : node?._`. Enclosures: `enclosure[0].$` for attributes
- The spec's `PublishResult` discriminated union is fully implemented with all error codes
- Test tasks T14–T16 cover: S3 upload with Buffer (not stream), GUID detection (plain + attributed), ETag/If-Match retry loop, S3 config validation, publish tool short-circuit on no config, path traversal/symlink/realpath rejection, file_not_found, shell metacharacters, invalid episodePublishedAt, missing-ETag behavior, partial failures
