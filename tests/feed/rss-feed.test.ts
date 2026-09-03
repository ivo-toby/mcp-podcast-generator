import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { RssFeedBackend, FeedError } from '../../src/feed/rss-feed.js';
import type { PodcastMetadata, EpisodeMetadata, MediaAsset } from '../../src/feed/feed-types.js';

// ---------------------------------------------------------------------------
// HTTP mock — supports a queue of responses
// ---------------------------------------------------------------------------
interface MockResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

let requestLog: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
let responseQueue: MockResponse[] = [];

function resetHttpMock() {
  requestLog = [];
  responseQueue = [];
}

globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) { headers[k] = v; }
    } else if (typeof init.headers === 'object') {
      Object.assign(headers, init.headers);
    }
  }
  let body: string | null = null;
  if (init?.body && typeof init.body === 'string') {
    body = init.body;
  }
  requestLog.push({ url, method: init?.method ?? 'GET', headers, body });

  // Pop the next response from the queue
  const resp = responseQueue.shift() ?? { status: 200, body: '', headers: {} };
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    statusText: resp.statusText ?? 'OK',
    headers: new Headers(resp.headers ?? {}),
    text: () => Promise.resolve(resp.body ?? ''),
  } as Response;
});

// Helper to enqueue responses
function enqueueResponses(...responses: MockResponse[]) {
  responseQueue.push(...responses);
}

describe('RssFeedBackend', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetHttpMock();
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

  const podcastMetadata: PodcastMetadata = {
    title: 'Test Podcast',
    link: 'https://example.com/podcast',
    description: 'A test podcast for unit testing.',
    author: 'Test Author',
    language: 'en-us',
    categories: ['Technology'],
  };

  const episodeMetadata: EpisodeMetadata = {
    title: 'Episode 1',
    description: 'First episode description.',
    guid: 'ep-001',
    publishedAt: '2024-01-01T00:00:00.000Z',
    durationSeconds: 600,
  };

  const mediaAsset: MediaAsset = {
    url: 'https://cdn.example.com/episodes/ep1.mp3',
    lengthBytes: 5000000,
    mimeType: 'audio/mpeg',
  };

  describe('new feed creation (404 GET)', () => {
    it('returns FeedResult on successful creation', async () => {
      enqueueResponses(
        { status: 404, body: '' },   // GET → not found
        { status: 201, body: '' }    // PUT → success
      );

      const backend = new RssFeedBackend(podcastMetadata);
      const result = await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      expect(result.feedUrl).toBe('https://cdn.example.com/podcast.xml');
      expect(result.episodeGuid).toBe('ep-001');
    });

    it('produces valid RSS 2.0 XML with required elements', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 201, body: '' }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.method).toBe('PUT');
      expect(lastReq.body).toContain('<rss version="2.0"');
      expect(lastReq.body).toContain('<channel>');
      expect(lastReq.body).toContain('<title>Test Podcast</title>');
      expect(lastReq.body).toContain('<item>');
      expect(lastReq.body).toContain('<title>Episode 1</title>');
      expect(lastReq.body).toContain('<description>First episode description.</description>');
      expect(lastReq.body).toContain('<enclosure');
    });

    it('includes iTunes podcast elements', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 201, body: '' }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('xmlns:itunes');
      expect(lastReq.body).toContain('<itunes:author>Test Author</itunes:author>');
      expect(lastReq.body).toContain('<itunes:title>Episode 1</itunes:title>');
    });

    it('sets enclosure type to audio/mpeg', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 201, body: '' }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('type="audio/mpeg"');
      expect(lastReq.body).toContain(`url="${mediaAsset.url}"`);
      expect(lastReq.body).toContain(`length="${mediaAsset.lengthBytes}"`);
    });

    it('handles XML special characters without double escaping', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 201, body: '' }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      const epWithSpecialChars: EpisodeMetadata = {
        title: 'Title & Subtitle <tag>',
        description: 'Desc with & special <chars>',
        guid: 'ep-special',
        publishedAt: '2024-01-01T00:00:00.000Z',
        durationSeconds: 100,
      };

      await backend.addEpisode('https://cdn.example.com/podcast.xml', epWithSpecialChars, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('&amp;');
      expect(lastReq.body).toContain('&lt;tag&gt;');
      expect(lastReq.body).not.toContain('&amp;amp;'); // no double escaping
    });
  });

  describe('duplicate GUID detection', () => {
    it('rejects update with duplicate GUID', async () => {
      const existingFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com/podcast</link>
    <description>A test podcast.</description>
    <item>
      <title>Existing Episode</title>
      <guid>ep-001</guid>
    </item>
  </channel>
</rss>`;
      enqueueResponses(
        { status: 200, body: existingFeed, headers: { 'etag': '"abc"' } },
        { status: 200, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await expect(
        backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset)
      ).rejects.toThrow();
    });
  });

  describe('ETag retry loop (412)', () => {
    const existingFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com</link>
    <description>Test.</description>
  </channel>
</rss>`;
    it('re-fetches on 412 and retries PUT', async () => {
      enqueueResponses(
        { status: 200, body: existingFeedXml, headers: { 'etag': '"abc"' } },
        { status: 412, body: '', headers: {} },
        { status: 200, body: existingFeedXml, headers: { 'etag': '"def"' } },
        { status: 200, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      expect(requestLog).toHaveLength(4);
      expect(requestLog[0].method).toBe('GET');
      expect(requestLog[1].method).toBe('PUT');
      expect(requestLog[2].method).toBe('GET');
      expect(requestLog[3].method).toBe('PUT');
    });

    it('throws rss_update_failed after 3 PUT attempts exhausted', async () => {
      enqueueResponses(
        { status: 200, body: '', headers: { 'etag': '"abc"' } },
        { status: 412, body: '', headers: {} },
        { status: 200, body: '', headers: { 'etag': '"def"' } },
        { status: 412, body: '', headers: {} },
        { status: 200, body: '', headers: { 'etag': '"ghi"' } },
        { status: 412, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      try {
        await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FeedError);
        const feedErr = err as FeedError;
        expect(feedErr.code).toBe('rss_update_failed');
      }
    });
  });

  describe('409 Conflict handling', () => {
    const existingFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com</link>
    <description>Test.</description>
  </channel>
</rss>`;
    it('re-fetches on 409; if 200 switches to update mode', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 409, body: '', headers: {} },
        { status: 200, body: existingFeedXml, headers: { 'etag': '"conflict"' } },
        { status: 200, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      expect(requestLog).toHaveLength(4);
    });

    it('409 in create mode + GET 404 → stays in create mode', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 409, body: '', headers: {} },
        { status: 404, body: '' },
        { status: 200, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);
      expect(requestLog[3].headers['If-None-Match']).toBe('*');
    });
  });

  describe('RFC 822 date formatting', () => {
    it('formats dates in RFC 822 UTC format', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 201, body: '' }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      const epWithDate: EpisodeMetadata = {
        title: 'Episode',
        description: 'Desc',
        guid: 'ep-date',
        publishedAt: '2024-01-15T10:30:00.000Z',
      };

      await backend.addEpisode('https://cdn.example.com/podcast.xml', epWithDate, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('Mon, 15 Jan 2024');
    });
  });

  describe('iTunes description truncation', () => {
    it('truncates description at 4000 chars at word boundary', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 201, body: '' }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      const longDesc = 'A'.repeat(4500);
      const epLong: EpisodeMetadata = {
        title: 'Episode',
        description: longDesc,
        guid: 'ep-long',
        publishedAt: '2024-01-01T00:00:00.000Z',
      };

      await backend.addEpisode('https://cdn.example.com/podcast.xml', epLong, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('<itunes:description>');
    });
  });

  describe('namespace repair on update', () => {
    it('adds missing xmlns declarations when updating a namespace-free feed', async () => {
      const nsFreeFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com</link>
    <description>Test.</description>
  </channel>
</rss>`;
      enqueueResponses(
        { status: 200, body: nsFreeFeed, headers: { 'etag': '"ns-free"' } },
        { status: 200, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('xmlns:itunes');
      expect(lastReq.body).toContain('xmlns:dc');
    });
  });

  describe('error codes', () => {
    it('returns rss_create_failed on creation PUT failure', async () => {
      enqueueResponses(
        { status: 404, body: '' },
        { status: 500, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      try {
        await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FeedError);
        const feedErr = err as FeedError;
        expect(feedErr.code).toBe('rss_create_failed');
      }
    });

    it('returns rss_update_failed on update PUT failure', async () => {
      const existingFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com</link>
    <description>Test.</description>
  </channel>
</rss>`;
      enqueueResponses(
        { status: 200, body: existingFeed, headers: { 'etag': '"abc"' } },
        { status: 500, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      try {
        await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FeedError);
        const feedErr = err as FeedError;
        expect(feedErr.code).toBe('rss_update_failed');
      }
    });
  });

  describe('empty feed update', () => {
    it('handles feed with zero items', async () => {
      const emptyFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com</link>
    <description>Test.</description>
  </channel>
</rss>`;
      enqueueResponses(
        { status: 200, body: emptyFeed, headers: { 'etag': '"empty"' } },
        { status: 200, body: '', headers: {} }
      );

      const backend = new RssFeedBackend(podcastMetadata);
      await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);

      const lastReq = requestLog[requestLog.length - 1];
      expect(lastReq.body).toContain('<item>');
    });
  });

  describe('FeedError type', () => {
    it('has stable discriminant codes', () => {
      const codes = ['rss_fetch_failed', 'rss_create_failed', 'rss_update_failed', 'rss_duplicate_guid'] as const;
      for (const code of codes) {
        expect(() => { throw new FeedError(code, 'test'); }).toThrow(FeedError);
      }
    });

    it('rss_fetch_failed on GET failure', async () => {
      enqueueResponses(
        { status: 0, body: '', headers: {} } // network error
      );

      const backend = new RssFeedBackend(podcastMetadata);
      try {
        await backend.addEpisode('https://cdn.example.com/podcast.xml', episodeMetadata, mediaAsset);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FeedError);
        const feedErr = err as FeedError;
        expect(feedErr.code).toBe('rss_fetch_failed');
      }
    });
  });
});
