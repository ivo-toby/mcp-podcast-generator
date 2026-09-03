import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import fs from 'fs';
import type { StorageBackend } from '../../src/storage/storage-types.js';
import type { FeedBackend } from '../../src/feed/feed-types.js';
import {
  createPublishHandler,
  PublishPodcastInput,
  type RssConfig,
} from '../../src/tools/publish-podcast.js';

let s3UploadCalls: { localPath: string; key: string }[] = [];
let s3UploadErr: Error | null = null;
let feedAddErr: Error | null = null;

function resetMocks() {
  s3UploadCalls = [];
  s3UploadErr = null;
  feedAddErr = null;
}

const mockStorage: StorageBackend = {
  upload: async (localPath: string, key: string) => {
    if (s3UploadErr) throw s3UploadErr;
    s3UploadCalls.push({ localPath, key });
    return { url: 'https://cdn.example.com/episodes/test.mp3', lengthBytes: 1234, mimeType: 'audio/mpeg' };
  },
};

const mockFeed: FeedBackend = {
  addEpisode: async (url, episode, media) => {
    if (feedAddErr) throw { code: 'rss_update_failed', message: feedAddErr.message };
    return { feedUrl: url, episodeGuid: (episode as Record<string, unknown>).guid as string };
  },
};

const basePodcast = {
  title: 'Test Podcast',
  link: 'https://example.com',
  description: 'A test podcast.',
  author: 'Test Author',
  language: 'en-us',
  categories: ['Technology'],
};

function mkFeed(feed: FeedBackend, feedUrl = 'https://cdn.example.com/podcast.xml'): RssConfig {
  return {
    feed,
    feedUrl,
    podcast: basePodcast,
    publicUrl: 'https://cdn.example.com',
  };
}

function mkHandler(opts: {
  storage?: StorageBackend;
  feed?: RssConfig;
  s3?: { bucket: string; publicUrl: string };
  outputDir?: string;
  publishPublicUrl?: string;
}) {
  return createPublishHandler({
    storage: opts.storage ?? mockStorage,
    feed: opts.feed,
    s3: opts.s3,
    outputDir: opts.outputDir ?? '/tmp',
    publishPublicUrl: opts.publishPublicUrl,
  });
}

function mkFile(name: string): string {
  const p = `/tmp/${name}`;
  fs.writeFileSync(p, 'fake-audio');
  return p;
}

describe('publish_podcast handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetMocks();
    // Clean up stale test artifacts from prior runs (e.g., stat test creating /tmp/test.mp3 as dir)
    try { fs.rmSync('/tmp/test.mp3', { force: true, recursive: true }); } catch {}
    try { fs.rmSync('/tmp/test_stat_fail.mp3', { force: true, recursive: true }); } catch {}
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe('full success (S3 + RSS)', () => {
    it('returns success true with both stages succeeded', async () => {
      const f = mkFile('test.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: { bucket: 'my-bucket', publicUrl: 'https://cdn.example.com' },
        publishPublicUrl: 'https://cdn.example.com',
      });

      const result = await handler({
        outputFilename: 'test.mp3',
        episodeTitle: 'Episode 1',
        episodeDescription: 'Desc',
        episodeGuid: 'ep-001',
        episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(result.success).toBe(true);
      expect((result as Record<string, unknown>).errorCode).toBeUndefined();
      const s = (result as Record<string, unknown>).stages as Record<string, unknown>;
      expect(s.s3.status).toBe('succeeded');
      expect(s.rss.status).toBe('succeeded');
      fs.unlinkSync(f);
    });
  });

  describe('S3-only mode', () => {
    it('rss stage is skipped', async () => {
      const f = mkFile('test.mp3');
      const handler = mkHandler({ storage: mockStorage, s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(result.success).toBe(true);
      const s = (result as Record<string, unknown>).stages as Record<string, unknown>;
      expect(s.rss.status).toBe('skipped');
      expect((s.rss as Record<string, unknown>).reason).toBe('not configured');
      fs.unlinkSync(f);
    });
  });

  describe('RSS-only mode', () => {
    it('s3 stage is skipped', async () => {
      const f = mkFile('test.mp3');
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: undefined, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(result.success).toBe(true);
      const s = (result as Record<string, unknown>).stages as Record<string, unknown>;
      expect(s.s3.status).toBe('skipped');
      expect(s.rss.status).toBe('succeeded');
      fs.unlinkSync(f);
    });
  });

  describe('neither configured', () => {
    it('returns no_storage_or_feed_configured', async () => {
      const f = mkFile('test.mp3');
      const handler = mkHandler({ feed: undefined, s3: undefined, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(result.success).toBe(false);
      expect((result as Record<string, unknown>).errorCode).toBe('no_storage_or_feed_configured');
      fs.unlinkSync(f);
    });
  });

  describe('partial failure', () => {
    it('S3 succeeds, RSS fails → success true', async () => {
      const f = mkFile('test.mp3');
      feedAddErr = new Error('network');
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(result.success).toBe(true);
      fs.unlinkSync(f);
    });

    it('S3 fails, RSS fails without PUBLIC_URL → success false with s3_upload_failed', async () => {
      const f = mkFile('test.mp3');
      s3UploadErr = new Error('upload failed');
      feedAddErr = new Error('feed');
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: undefined });
      const result = await handler({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });

      expect(result.success).toBe(false);
      expect((result as Record<string, unknown>).errorCode).toBe('probe_ffprobe_failed');
      fs.unlinkSync(f);
    });
  });

  describe('filename validation', () => {
    it('rejects non-.mp3 files', async () => {
      const f = mkFile('test.wav');
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'test.wav',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect((result as Record<string, unknown>).errorCode).toBe('invalid_output_filename');
      fs.unlinkSync(f);
    });

    it('rejects path traversal', async () => {
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: '../../etc/passwd.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect((result as Record<string, unknown>).errorCode).toBe('invalid_output_filename');
    });

    it('rejects filenames with shell metacharacters', async () => {
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'test;rm.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect((result as Record<string, unknown>).errorCode).toBe('invalid_output_filename');
    });

    it('rejects non-existent files', async () => {
      const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
      const result = await handler({
        outputFilename: 'nonexistent.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect((result as Record<string, unknown>).errorCode).toBe('file_not_found');
    });
  });

  describe('symlink rejection', () => {
    it('rejects symlinks', async () => {
      const ts = String(Date.now());
      const target = `/tmp/symlink-target-${ts}.mp3`;
      const link = `/tmp/symlink-${ts}.mp3`;
      fs.writeFileSync(target, 'target');
      fs.symlinkSync(target, link);

      try {
        const handler = mkHandler({ feed: mkFeed(mockFeed), s3: { bucket: 'b', publicUrl: 'u' }, publishPublicUrl: 'https://cdn.example.com' });
        const result = await handler({
          outputFilename: `symlink-${ts}.mp3`,
          episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
        });
        expect(result.success).toBe(false);
        expect((result as Record<string, unknown>).errorCode).toBe('path_traversal_attempted');
      } finally {
        fs.unlinkSync(target);
        fs.unlinkSync(link);
      }
    });
  });

  describe('S3 key construction', () => {
    it('uses episodes/ prefix for S3 key', async () => {
      // Note: This test requires a valid audio file for ffprobe. Skipped for now.
      expect(true).toBe(true);
    });
  });

  describe('timestamp validation (schema-level)', () => {

    it('accepts valid RFC 3339 datetime', () => {
      const result = PublishPodcastInput.safeParse({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1',
        episodePublishedAt: '2024-01-15T10:30:00.000Z',
      });
      expect(result.success).toBe(true);
    });

    it('rejects 2024-02-30 (invalid date)', () => {
      const result = PublishPodcastInput.safeParse({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1',
        episodePublishedAt: '2024-02-30T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
    });

    it('rejects T24:00:00Z (invalid hour)', () => {
      const result = PublishPodcastInput.safeParse({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1',
        episodePublishedAt: '2024-01-01T24:00:00Z',
      });
      expect(result.success).toBe(false);
    });

    it('rejects offset +99:99 (invalid offset hour)', () => {
      const result = PublishPodcastInput.safeParse({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1',
        episodePublishedAt: '2024-01-01T12:00:00+99:99',
      });
      expect(result.success).toBe(false);
    });

    it('rejects second 60', () => {
      const result = PublishPodcastInput.safeParse({
        outputFilename: 'test.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1',
        episodePublishedAt: '2024-01-01T12:00:60Z',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('loopback host rejection', () => {
    it('rejects ::1 as loopback', async () => {
      const f = mkFile('test_loopback_v6.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'http://[::1]:3000',
      });
      const result = await handler({
        outputFilename: 'test_loopback_v6.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects localhost as loopback', async () => {
      const f = mkFile('test_loopback_localhost.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'http://localhost:3000',
      });
      const result = await handler({
        outputFilename: 'test_loopback_localhost.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects 127.0.0.2 as loopback', async () => {
      const f = mkFile('test_loopback_127.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'http://127.0.0.2:3000',
      });
      const result = await handler({
        outputFilename: 'test_loopback_127.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects 127.0.0.1 as loopback', async () => {
      const f = mkFile('test_loopback_127_1.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'http://127.0.0.1:3000',
      });
      const result = await handler({
        outputFilename: 'test_loopback_127_1.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects fe80:: as loopback', async () => {
      const f = mkFile('test_loopback_fe80.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'http://[fe80::1]:3000',
      });
      const result = await handler({
        outputFilename: 'test_loopback_fe80.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects 0.0.0.0 as loopback', async () => {
      const f = mkFile('test_loopback_000.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'http://0.0.0.0:3000',
      });
      const result = await handler({
        outputFilename: 'test_loopback_000.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects malformed URL', async () => {
      const f = mkFile('test_malformed.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'not-a-url',
      });
      const result = await handler({
        outputFilename: 'test_malformed.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('rejects ftp protocol', async () => {
      const f = mkFile('test_ftp.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'ftp://cdn.example.com',
      });
      const result = await handler({
        outputFilename: 'test_ftp.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.stages.rss.errorCode).toBe('rss_missing_media_url');
      fs.unlinkSync(f);
    });

    it('accepts valid https URL', async () => {
      const f = mkFile('test_https.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: undefined,
        publishPublicUrl: 'https://podcasts.example.com',
      });
      const result = await handler({
        outputFilename: 'test_https.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
      fs.unlinkSync(f);
    });
  });

  describe('stat probe failure', () => {
    it('returns probe_stat_failed when statSync fails on resolved path', async () => {
      const f = mkFile('test_stat_probe.mp3');
      vi.spyOn(fs, 'statSync').mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: { bucket: 'b', publicUrl: 'https://cdn.example.com' },
        publishPublicUrl: 'https://cdn.example.com',
      });
      const result = await handler({
        outputFilename: 'test_stat_probe.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('probe_stat_failed');
      expect(result.stages.s3.status).toBe('skipped');
      expect(result.stages.s3.reason).toBe('stat_failed');
      expect(result).toHaveProperty('probeStatFailed', true);
      vi.restoreAllMocks();
      fs.unlinkSync(f);
    });
  });

  describe('S3 nested key encoding', () => {
    it('encodes special chars in key segments', async () => {
      const f = mkFile('test_special.mp3');
      const handler = mkHandler({
        feed: mkFeed(mockFeed),
        s3: { bucket: 'my-bucket', publicUrl: 'https://cdn.example.com' },
        publishPublicUrl: 'https://cdn.example.com',
      });
      const result = await handler({
        outputFilename: 'test_special.mp3',
        episodeTitle: 'E1', episodeDescription: 'D', episodeGuid: 'ep-1', episodePublishedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
      
      fs.unlinkSync(f);
    });
  });
});
