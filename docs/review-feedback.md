# Review Feedback: S3 + RSS Publish

Review of `docs/SPEC-upload-publish.md`, `docs/implementation-plan.md`, `docs/research-api-integration.md` against the current codebase (`src/index.ts`, `src/tools/generate-podcast.ts`, `src/utils/download.ts`, `docker-compose.yml`, `.env.example`). Verdict: **not ready to implement — 6 P1s need decisions first.**

## P1 (implementing as written produces a defect)

**1. RSS-only mode advertises URLs where the file doesn't exist.** Spec step 8a builds the enclosure as `${PUBLIC_URL}/output/${file}` when S3 is absent, but nothing ever uploads the file to `PUBLIC_URL`. Failure scenario: `PUBLIC_URL=https://cdn.example.com`, publish returns `success:true`, every enclosure 404s because the MP3 only sits in local `/output`. The design only works if `PUBLIC_URL` is this server itself — the spec never constrains it to that, and its own example uses a CDN-style URL. Fix: require `PUBLIC_URL` to be the server's own base URL in RSS-only mode, or drop RSS-only fallback.

**2. Concurrency claim contradicts the documented limitation.** Plan T15 asserts "concurrent identical GUIDs → duplicate detection catches second" unconditionally. But if the feed host returns no ETag, PUTs are last-write-wins and both appends succeed — you get two items with the same GUID. The duplicate guarantee only holds on ETag-supporting hosts. Fix: scope the claim, or add read-back verification.

**3. Two validators, two error shapes.** Plan T7 says the Zod schema enforces `.mp3` ending *and* the handler re-validates basename into `invalid_output_filename`. But the MCP SDK validates the registered schema *before* the handler runs — so a Zod-level reject returns an SDK schema error, not the `PublishResult` envelope. Failure scenario: `outputFilename: "evil"` gets a transport-level validation error in one path and `invalid_output_filename` in another, depending on which check fires. Tests in T13/T15 all assume the envelope. Fix: make the Zod schema purely `z.string()` and put 100% of filename validation in the handler.

**4. No size cap + whole-file Buffer = OOM crash.** Research says 20–200 MB "well within 1G" — for *one* file. Failure scenario: two concurrent `publish_podcast` calls on 200 MB files + an in-flight TTS buffer exhaust the 1G compose limit and the whole process (all requests) dies. There is no max-size check, no multipart streaming, no upload timeout. Fix: add a size limit (reject before `readFile`) and/or timeouts.

**5. "Minimal HTML" descriptions are broken by design.** Spec allows HTML in `episodeDescription`, then routes it through xml2js `Builder`, which escapes it. Failure scenario: description `<p>Hello</p>` lands in `<content:encoded>` as `&lt;p&gt;Hello&lt;/p&gt;` and readers show literal tags. Either restrict to plain text or wrap in CDATA.

**6. `PUBLIC_URL` startup check is ambiguous against existing code.** `src/index.ts` already defaults `PUBLIC_URL` to `http://localhost:3000`. Plan T7 says the handler's fallback has "no default to localhost," while T8 fatals when RSS-without-S3 lacks `PUBLIC_URL`. Failure scenario depends on what's checked: raw `process.env.PUBLIC_URL` (then a default local run fatals despite the existing default) or `config.publicUrl` (then the check never fires and you silently publish `http://localhost:3000/...` enclosures to the world). Fix: state exactly which value is validated and reject localhost as an enclosure base.

## P2 (a reader can reasonably build the wrong thing)

- **Shell-metacharacter list undefined.** Spec rejects "shell metacharacters" but spawn uses argv (no shell), so the check only risks false rejects (`o'brien (1).mp3`). Also: is `.MP3` accepted? Null bytes (`\0`) make `path.join` throw — violating "never throws."
- **TOCTOU on path checks.** `lstat → realpath → stat → readFile` are separate syscalls; a swapped symlink between lstat and readFile bypasses the traversal check. Re-lstat after realpath or open with `O_NOFOLLOW`.
- **Probe failures invisible on success.** stat fails → RSS enclosure `length=0`, but `success:true` omits `errorCode` — the client can't distinguish length 0 from real 0. Enclosure quality signal is swallowed.
- **No timeouts anywhere.** ffprobe spawn, S3 `send`, feed GET/PUT — none specify timeouts. One hung backend hangs the MCP handler indefinitely.
- **Retry count ambiguous.** "Up to 3 retries" — 3 total PUTs or 1+3? Implementer and test author can reasonably pick different numbers.
- **"Exact template" test is brittle.** Element order from xml2js follows JS insertion order; update path mutates parsed objects, so creation and update output differ in order/whitespace. Byte-exact matching will flake.
- **Truncation semantics missing.** `itunes:description` cut at "4,000 characters" — chars vs bytes? Mid-surrogate or mid-entity splits? Unspecified.
- **PUT status mapping incomplete.** Only 412/409/404 handled. A 403/428/500 on PUT maps to... unspecified errorCode.
- **Secret logging.** T2 says "log upload progress" with no fields. S3 secret must never hit logs — state the allow-list.
- **Plan bookkeeping errors:** two tasks both numbered T9 (package.json + config tests), T13 contains handler path tests that belong in T15, T15 lists "S3 fails, RSS succeeds" twice. An implementer working task-by-task builds the wrong coverage.
- **pubDate timezone.** RFC 3339 input → RFC 822 output; "now" in which zone, and is the conversion UTC-normalized? Unspecified.
- **XXE/entity expansion.** Feed XML is parsed with default xml2js settings; no DTD/entity limits stated. Low risk (URL is operator-configured), but worth one line.

## Research doc notes

The library findings themselves are solid (Buffer-over-stream for #5479, no manual escaping with Builder, `standalone` omission, namespace repair). Two gaps: the risk table's "falls back to compact output" fallback doesn't exist in the plan, and "no alternative considered" for S3 is fine as a decision but shouldn't be presented as research. Neither blocks implementation.

Suggested fix order: P1-1 (scoping of RSS-only), P1-3 (validation ownership), P1-6 (PUBLIC_URL semantics) are all the same underlying decision about what `PUBLIC_URL` means — settle that first and three P1s collapse into one.
