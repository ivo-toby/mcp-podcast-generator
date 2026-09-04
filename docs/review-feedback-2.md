# Review Feedback (Second Review): S3 + RSS Publish

Second adversarial review of `docs/SPEC-upload-publish.md`, `docs/implementation-plan.md`, `docs/research-api-integration.md` against each other and the existing codebase (`src/index.ts`, `src/tools/generate-podcast.ts`, `src/utils/download.ts`, `docker-compose.yml`, `.env.example`), incorporating the first review (`docs/review-feedback.md`).

**Verdict: not yet ready — 4 P1s (1 residual, 3 patch-introduced), 12 P2s. The patches fixed ~4 of the original 6 P1s but introduced fresh defects.**

## What the patches fixed (verified)

- **P1-1 (RSS-only URL scoping): fixed and coherent with code.** SPEC step 8a, research decision 11, and plan T5/T7 all now constrain `PUBLIC_URL` to the server's own base URL. Verified against `src/index.ts`: `app.use('/output', express.static(config.outputDir))` exists, so the `/output/` fallback enclosure is servable. Good.
- **P1-5 (HTML descriptions): fixed.** All three docs now say plain text only (SPEC schema/template/interfaces, research 17, plan T7/Notes).
- **Retry semantics in SPEC: fixed** ("3 total PUT attempts"). But see P2-1 — the plan still disagreed.
- **Duplicate task numbering: fixed** (T9 → T9/T9b).

## P1 (implementing as written produces a defect)

### P1-1 (residual): Plan T7 still constrains `.mp3` in the Zod schema — first-review P1-3 is NOT closed

Plan T7's schema bullet reads: *"Export `PublishPodcastInput` Zod schema (structurally permissive … basename validation done in handler): `outputFilename: string (must end in .mp3)`."* The header says the handler owns basename validation; the field line says the schema enforces `.mp3`. An implementer following the field line puts `.mp3` in Zod → MCP SDK rejects before the handler → transport-level error instead of the `PublishResult` envelope — the exact defect from first-review P1-3, reproduced. Meanwhile research decision 18 says bare `z.string()`. The three docs do not agree. **Fix:** change the plan line to `outputFilename: bare z.string() (no constraints — handler validates)`.

### P1-2 (new): Space rejection breaks the generate→publish workflow

Plan T7's handler validation rejects *"shell metacharacters (spaces, quotes, `;` `&` `|` `$` `` ` ``)"*. But `src/tools/generate-podcast.ts` accepts `outputFilename: z.string().min(1)` — **spaces fully allowed**. So `generate_podcast` happily creates `my episode.mp3`, and `publish_podcast` rejects it with `invalid_output_filename` for a file that exists and was produced by the sibling tool. Since `ffprobe` is spawned via argv (no shell), spaces/quotes are harmless — the rejection list has no security justification, only false rejects (the first review warned about this; the patch enumerated spaces explicitly). **Fix:** drop spaces/quotes from the reject list; restrict to `/ \ ..` null bytes + `.mp3` suffix (keep realpath check for traversal).

### P1-3 (new): SPEC's `PUBLIC_URL` example contradicts plan T8's localhost rejection

SPEC's env table gives the RSS-only `PUBLIC_URL` example as `http://localhost:3000`. Plan T8 says *"reject localhost (`http://localhost:*`) as a public enclosure URL."* einander widersprechend: SPEC-blessed config fatals at startup per the plan, and T9b has no localhost test so the behavior is untested either way. **Fix:** change the SPEC example to a non-localhost URL AND define the localhost match precisely (bare `localhost`? `127.0.0.1`? `::1`? with/without port?) — currently only one spelling is named.

### P1-4 (residual/hole): Size cap is bypassed exactly when size is unknown + T2's check has no size source

SPEC step 7a gates on `fileSizeBytes > 500MB`, but step 5 sets `fileSizeBytes` to `undefined` when `stat` fails and continues. `undefined > cap` is `false` → unbounded `readFile` → OOM in precisely the branch where size is unverified. Separately, plan T2 puts the size check inside `S3StorageBackend.upload(localPath, key)` — a signature with **no size parameter**, so the check is unimplementable as written (implementer must add an undisclosed second `stat`, opening a new TOCTOU window vs the handler's `stat`). **Fix:** define behavior for unknown size (reject, or check `buffer.byteLength` post-read and abort before `send`), and put the single authoritative check in ONE place (handler, which already has `fileSizeBytes`) instead of both.

## P2 (a reader can reasonably build the wrong thing)

- **P2-1 (carryover): retry-count conflict persists.** SPEC: 3 total PUTs. Plan T5: *"Loop up to 3 retries"* with three backoffs (100/300/900ms) — i.e. up to 4 PUTs. One-line fix, still not applied.
- **P2-2: T15 files SDK-level checks as handler tests.** Title/description length, `episodePublishedAt` format, negative `episodeNumber` are Zod/SDK-validated (never reach `createPublishHandler`), yet T15 lists them under `publish-podcast.test.ts` handler tests. Calling the handler directly bypasses SDK validation, so these tests fail-or-vacuous as written. Move to schema-level tests; also specify the Zod shape for `episodePublishedAt` (`.datetime()`? `.refine()`?) — currently just "RFC 3339 string."
- **P2-3: PUT `Content-Type` unspecified.** No `application/rss+xml` (or `application/xml`) header is named for feed PUTs; strict hosts may 415/428 → unmapped error path.
- **P2-4: backend→handler error propagation is string-prefix matching.** Plan T5: backends "throw with specific errorCode prefixes"; handler parses prefixes. Brittle (message refactors silently break mapping). Specify a typed error (`code` field) instead.
- **P2-5: SPEC contradicts itself on XML matching.** Testing Strategy still demands new feeds match *"the template exactly"* while Residual Risks mandates structural (parse+compare) comparison — and plan T14 agrees with the latter. Fix the Testing Strategy line.
- **P2-6: error-table probe examples omit the new flags.** The `probe_stat_failed`/`probe_ffprobe_failed` success rows show payloads without `probeStatFailed: true` / `probeFFprobeFailed: true`, contradicting the flags rule directly below them.
- **P2-7: T9b startup tests are unimplementable without refactor.** `src/index.ts` has import-time side effects (`mkdir`, `app.listen`, `process.exit(1)` on missing `GOOGLE_API_KEY`) — it cannot be imported by a test. Plan needs a task to extract config validation (e.g. `buildConfig()`/`validateStartupConfig()`) into an importable module.
- **P2-8: timeout mechanisms unspecified for all four timeouts.** S3 has no `timeout` option on `PutObjectCommand` (needs `NodeHttpHandler({ requestTimeout })`); `fetch` needs `AbortSignal.timeout()`; `readFile` needs a signal; ffprobe needs kill-on-timeout semantics. Names, not just durations.
- **P2-9: oversize maps to `invalid_output_filename`.** The filename is valid; the file is too big. Misleads clients; add `file_too_large` to the code union.
- **P2-10: concurrent-memory accumulation undocumented.** The 500MB cap bounds one file, not two concurrent 500MB uploads + in-flight TTS buffers against the 1G compose limit. Note as residual or bound concurrency.
- **P2-11 (carryover): T13 still contains handler path tests** (`lstat().isFile()`, lstat-throws) that belong in T15.
- **P2-12 (adjacent, pre-existing): `generate_podcast` has no traversal guard** (`path.join(outputDir, input.outputFilename)`, `z.string().min(1)`). Out of scope for this feature but worth one line since publish's threat model assumes files live in `outputDir`.

## P3 / editorial (patch-merge damage)

- Plan now has **two `## Verification` headings** (first one empty) and the Timeout Coverage list **duplicates** the feed/S3/readFile lines.
- T15 still lists "S3 fails, RSS succeeds" twice (carryover).
- Plan T5 holds a `publishPublicUrl` line that belongs to T7 (backend never sees that URL — the handler builds the `MediaAsset`).
- SPEC step 1 omits null bytes (validation section has them); `s3_config_invalid` sits in the envelope union though it can never appear in an envelope (startup fatals); research "20–200 MB" is stale next to the 500 MB cap; `pubDate` "toISOString then convert" should just be `toUTCString()` (already RFC-822/GMT); ffprobe duration source (`-show_format` vs streams) unspecified.

## Suggested fix order

P1-1 + P2-2 are the same validation-ownership decision — settle which checks live in Zod vs handler, then fix the schema line and re-file the tests together. P1-2 (drop spaces from the reject list) and P1-3 (SPEC example + localhost definition) are each one-line doc edits. P1-4 needs the unknown-size decision before touching T2/T7.

Session file: /home/ivo/.config/pi/agent/sessions/--home-ivo-workspace-mcp-podcast-generator--/2026-09-03T11-46-04-094Z_01a06717-20be-77b5-8e61-db839de1ae09/forks/2026-09-03T12-34-52-602Z_01a06743-d03a-7602-8a33-729bb35d13ce.jsonl
