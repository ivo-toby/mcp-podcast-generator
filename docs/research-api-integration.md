# Research: S3 + RSS Implementation

This document captures findings on the three core libraries and their integration with the existing codebase.

---

## 1. `@aws-sdk/client-s3` — S3 Upload

### API Surface

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false,  // optional, for MinIO
});

const buffer = await fs.promises.readFile(localPath);
await client.send(new PutObjectCommand({
  Bucket: 'my-bucket',
  Key: 'episodes/episode-42.mp3',
  Body: buffer,
  ContentType: 'audio/mpeg',
  ContentLength: buffer.byteLength,
}));
```

### Critical Finding: Stream Retry Issue (#5479)

**AWS SDK v3 issue**: passing a readable stream to `PutObjectCommand` will **hang if a retry happens**. This is because Node streams cannot be rewound — when the SDK retries the request, it can't re-read the stream.

**Impact**: If S3 returns a transient error (503 Slow Down, 500), the SDK retries the request, but the stream is already consumed → the retry hangs indefinitely.

**Decision**: Read the file into a Buffer with `fs.promises.readFile()` (async). Podcast MP3s vary widely (10 MB to 500 MB); enforce the 500 MB cap with `file_too_large` before `readFile`. Always Buffer. `ContentLength` is derived from `buffer.byteLength`, not from `stat()`.

### Key Details
- `ContentLength` provided from `buffer.byteLength` for correctness
- `forcePathStyle: true` for MinIO, `false` for R2/AWS
- The `@aws-sdk/client-s3` package is modular — only the parts we use are bundled
- No authentication helpers needed — we pass credentials directly

---

## 2. `xml2js` — XML Parsing & Building

### API Surface

#### Parsing (parseStringPromise)

```typescript
import { parseStringPromise } from 'xml2js';

const result = await parseStringPromise(xml, {
  // Defaults work well for our use case:
  // - attrkey: '$' (attributes are under this key)
  // - charkey: '_' (text content is under this key)
  // - explicitArray: true (arrays always)
});

// Parsed result structure (default xml2js: attrkey='$', charkey='_', explicitArray=true):
// For: <item><itunes:title>My Title</itunes:title></item>
// result.rss.channel[0]['itunes:title'][0] = 'My Title'
// For: <guid isPermaLink="false">my-guid</guid>
// result.rss.channel[0].guid[0] = { _: 'my-guid', $: { isPermaLink: 'false' } }
// For: <enclosure url="http://..." type="audio/mpeg" length="1234"/>
// result.rss.channel[0].enclosure[0] = { $: { url: 'http://...', type: 'audio/mpeg', length: '1234' } }
```

**Important**: xml2js preserves colons in tag names. `<itunes:title>` becomes the key `'itunes:title'` in the resulting object. This means existing feed parsing will work — we can detect and preserve namespaced elements.

#### Building (Builder.buildObject)

```typescript
import { Builder } from 'xml2js';

const builder = new Builder({ renderOpts: { pretty: true, indent: '  ' }, xmldec: { version: '1.0', encoding: 'UTF-8' } });
// Note: omit standalone property — setting standalone: false produces standalone="no" which contradicts the exact template <?xml version="1.0" encoding="UTF-8"?>
const xml = builder.buildObject(obj);

// Tag names with colons are supported:
const obj = {
  'rss': {
    $: { version: '2.0', 'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd', /* etc */ },
    channel: {
      'itunes:title': ['Title'],
      'itunes:author': ['Author'],
    }
  }
};
// Produces: <rss version="2.0" xmlns:itunes="..."><channel><itunes:title>Title</itunes:title>...
```

**Key finding**: `buildObject` supports:
- Colon-prefixed tag names (`'itunes:title'`) — produces `<itunes:title>` in XML
- `$` for attributes — produces attributes in XML
- `'xmlns:prefix'` in `$` — produces namespace declarations

This means we can use xml2js for **both parsing and building** — a clean round-trip for existing feeds.

### Key Details
- `parseStringPromise` returns a Promise — no callback needed
- `Builder` outputs pretty-printed XML by default. For consistent XML declaration, configure `xmldec: { version: '1.0', encoding: 'UTF-8' }` (omit standalone — false produces `standalone="no"`) and `renderOpts: { pretty: true, indent: '  ' }`.
- `renderOpts` is an xml2js Builder option for controlling indentation and line endings.
- For namespace-preserving updates, the parsed object retains all existing elements under their original keys

### Update Flow Considerations

When updating an existing feed:
1. `parseStringPromise(existingXml)` → object
2. Navigate to `result.rss.channel[0]` — the parsed channel object
3. Navigate to `result.rss.channel[0].item` — ensure array with `channel.item ??= []` (xml2js omits the key when no <item> exists)
4. Check for duplicate GUID: iterate items, `const node = item.guid?.[0]; const guid = typeof node === 'string' ? node : node?._; compare against requested GUID`. Test both `<guid>value</guid>` (plain text → `['value']`) and `<guid isPermaLink="false">value</guid>` (attributed → `[{_: 'value', $: {isPermaLink: 'false'}}]`).
5. Build new item object with namespaced keys (`'itunes:title'`, etc.)
6. Push new item to `result.rss.channel[0].item`
7. `new Builder().buildObject(result)` → XML string
8. PUT with If-Match

**Builder configuration** (shared for both creation and update): `{ renderOpts: { pretty: true, indent: '  ' }, xmldec: { version: '1.0', encoding: 'UTF-8' } }` — omit standalone property to avoid `standalone="no"` output

The round-trip preserves all existing channel fields because we're mutating the parsed object, not rebuilding from scratch.

**Namespace repair on update**: If the existing feed's `<rss>` element lacks `xmlns:itunes`, `xmlns:dc`, or `xmlns:content` declarations, add them to `result.rss.$` before serialization. This ensures the new `<item>`'s namespaced elements are valid XML.

---

## 3. Integration with Existing Codebase

### `src/index.ts` — Entry Point

**Current pattern**:
- Config object built from `process.env` at module scope
- `createMcpServer()` factory creates a fresh `McpServer` per request
- `server.tool()` registers each MCP tool with input schema + handler
- Express app created outside factory, middleware registered globally

**Changes needed**:
- Read S3 + RSS env vars at module scope (same pattern as existing config)
- Validate S3 config: all-or-none check. If partial, log fatal + exit. If absent, set `storage = null`.
- Validate RSS config: if `RSS_FEED_URL` set, require `PODCAST_TITLE`, `PODCAST_DESCRIPTION`, `PODCAST_LINK`, `PODCAST_AUTHOR`. If RSS configured without S3, also require `PUBLIC_URL`. Otherwise `feedBackend = null`.
- In `createMcpServer()`, register `publish_podcast` tool
- The tool handler imports `createPublishHandler` statically — no circular dependency risk
- Storage and feed backends are instantiated once at module scope, then passed to the handler factory

**File structure after changes**:
```
src/
  index.ts              — main entry, registers tools
  storage/
    storage-types.ts    — MediaAsset, StorageBackend, S3Config, validateS3Config()
    s3-storage.ts       — S3StorageBackend
    index.ts            — re-export
  feed/
    feed-types.ts       — FeedBackend, EpisodeMetadata, PodcastMetadata, PublishResult
    rss-feed.ts         — RssFeedBackend
    index.ts            — re-export
  tools/
    publish-podcast.ts  — createPublishHandler() + input schema
```

### `src/tools/generate-podcast.ts` — Reference Pattern

**Key patterns to follow**:
- Zod schema for input validation (`z.object({...}).shape`)
- Type export: `export type GeneratePodcastInputType = z.infer<typeof GeneratePodcastInput>`
- Return type interface: `export interface GeneratePodcastOutput {...}`
- `childLogger` from `src/utils/logger.ts` for child logging
- `mkdir` from `fs/promises` for directory creation

### `src/utils/logger.ts` — Logging Pattern

```typescript
import pino from 'pino';
import pretty from 'pino-pretty';
import { childLogger } from '../utils/logger.js';
const log = childLogger('module-name');
log.info({ ... }, 'message');
```

### Dependency Changes

**package.json additions**:
- `dependencies`: `@aws-sdk/client-s3`, `xml2js`
- `devDependencies`: `@types/xml2js`

**docker-compose.yml**: Add S3 and RSS env vars to environment block, plus `PUBLIC_URL`.

**.env.example**: Add S3 vars (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_URL, S3_FORCE_PATH_STYLE), RSS vars (RSS_FEED_URL, PODCAST_TITLE, PODCAST_DESCRIPTION, PODCAST_LINK, PODCAST_AUTHOR, PODCAST_LANGUAGE, PODCAST_CATEGORIES), and `PUBLIC_URL`.

---

## 4. Integration Risks & Mitigations

| Risk | Mitigation |
|---|---|
| S3 stream retry hang (#5479) | Read file into Buffer with `fs.promises.readFile()` — always Buffer, never streaming |
| xml2js namespace preservation on update | Build new item with namespaced keys; use Builder which handles colons natively |
| xml2js pretty-printing | Use Builder with renderOpts for consistent output; compact fallback not supported |
| Circular dependency: index.ts imports from tools, tools imports from storage/feed | Static imports work — no reverse dependency; construct handler once at startup |
| xml2js parse failures on malformed feeds | Catch parse errors, map to `rss_fetch_failed` |
| xml2js build failures on complex objects | Wrap buildObject in try/catch, map to `rss_create_failed` (mode === 'create') or `rss_update_failed` (mode === 'update') |

| ETag handling on non-S3 hosts | Some self-hosted RSS hosts may not return ETags; handle missing ETag gracefully |

---

## 5. Alternative Libraries Considered

### S3 Upload
- `@aws-sdk/client-s3` `PutObjectCommand` with Buffer is the chosen path. No viable alternatives at the required scale and compatibility.

### XML
- `fast-xml-parser`: Faster, but has poorer namespace support and no builder for pretty XML. **Decision: skip.**
- `xmldom` + `xmlbuilder2`: More control, but more complex API. **Decision: skip — xml2js round-trip is simpler.**

---

## 6. Summary of Key Decisions

1. **S3 upload**: Use `PutObjectCommand` with `await fs.promises.readFile(path)` → Buffer. This avoids the retry-hang issue (#5479). `ContentLength` derived from `buffer.byteLength`, not from `stat()`. Podcast sizes range from ~10 MB to 500 MB — enforce the 500 MB cap before `readFile`.
2. **XML**: Use `xml2js` for both parsing and building. Colons in tag names are natively supported. `$` for attributes, `xmlns:prefix` for namespace declarations. NO manual xmlEscape — Builder already escapes text content.
3. **Static import**: `src/index.ts` can statically import `createPublishHandler` — no circular dependency risk. No dynamic import needed.
4. **Buffer size / concurrency**: A single 500 MB Buffer fits in the 1 GB container, but two concurrent 500 MB uploads plus in-flight TTS buffers could OOM. Consider bounding concurrency (e.g. one upload at a time) or adding a memory budget guard.
5. **xml2js parsed object navigation**: `result.rss.channel[0]` for channel. For GUIDs: `const node = guid?.[0]; const value = typeof node === 'string' ? node : node?._`. For enclosures: `enclosure[0].$` for attributes.
6. **Namespace repair on update**: Ensure `result.rss.$` has `xmlns:itunes`, `xmlns:dc`, `xmlns:content` declarations before serialization.
7. **S3 config**: Check 5 required vars; if any set, all required must be present. `S3_REGION` defaults to `us-east-1` only when absent. `S3_FORCE_PATH_STYLE` parsed strictly (only 'true' enables it). Setting only `S3_FORCE_PATH_STYLE` does NOT count as S3 configured.
8. **XML xmldec**: Configure `xmldec: { version: '1.0', encoding: 'UTF-8' }` — omit standalone to avoid `standalone="no"` output that contradicts the exact template.
9. **publishPublicUrl**: Pass optional RSS fallback URL separately from `config.publicUrl` (which defaults to localhost for `generate_podcast`). When RSS configured without S3, `PUBLIC_URL` is required at startup.
10. **URL normalization**: All base URLs (S3_PUBLIC_URL, PUBLIC_URL) must have trailing slash stripped before URL assembly. All path segments (filenames, S3 keys) must be encoded via `encodeURIComponent()` to prevent double-slash resource paths and handle special characters.
11. **RSS-only semantics**: In RSS-only mode (no S3), the MP3 stays on the local filesystem. `PUBLIC_URL` must be the server's own base URL — not a CDN URL. The `/output/` Express route serves the file.
12. **Timeouts**: ffprobe spawn 30s, feed HTTP GET/PUT 10s, S3 upload 5 min (SDK config), readFile 30s.
13. **Logging safety**: Upload progress log fields are key, bucket, status, bytes — never credentials or secrets.
14. **XML comparison for tests**: Use structural comparison (parse+compare trees), not byte-exact, because xml2js insertion order differs between create and update paths.
15. **Duplicate detection**: Only works reliably on ETag-supporting hosts. On non-ETag hosts, concurrent identical GUIDs may produce duplicate items.
16. **XXE protection**: `parseStringPromise` called with `{ whitelist: [], maxDepth: 100 }`.
17. **Description format**: Plain text only — HTML is escaped by the Builder. Truncated to 4,000 chars (not bytes) at word boundary.
18. **Zod schema**: `outputFilename` is bare `z.string()` — all basename validation (`.mp3`, path traversal, shell metacharacters) is in the handler so all errors flow through the `PublishResult` envelope.
19. **Size limit**: Reject files > 500 MB before `readFile` to prevent OOM.
20. **pubDate**: Format to RFC 822 in UTC.
