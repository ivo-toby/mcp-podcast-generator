import {
  Builder,
  parseStringPromise,
} from 'xml2js';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type {
  FeedBackend,
  FeedErrorCode,
  EpisodeMetadata,
  PodcastMetadata,
  FeedResult,
} from './feed-types.js';
import type { S3StorageBackend } from '../storage/s3-storage.js';
const MAX_FEED_XML_SIZE = 2 * 1024 * 1024; // 2 MB

/**
 * Shared xml2js builder options.
 *
 * standalone is omitted intentionally — setting it to false produces
 * standalone="no" in output, which contradicts the exact template requirement.
 */
const BUILDER_OPTS = {
  renderOpts: { pretty: true, indent: '  ' },
  xmldec: { version: '1.0', encoding: 'UTF-8' },
};

/**
 * Shared xml2js parser options.
 *
 * feed URLs are operator-configured (not user-supplied), so XXE risk is low.
 * xml2js 0.6 ignores whitelist/maxDepth — we validate input size instead.
 */
const PARSER_OPTS: import('xml2js').ParserOptions = {};

const FETCH_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = [100, 300];
const MAX_RETRY_COUNT = 3;

/**
 * RSS feed backend using xml2js for parsing and building XML.
 * Uses S3 storage when available, falls back to HTTP PUT/GET for RSS-only mode.
 */
export class RssFeedBackend implements FeedBackend {
  private podcast: PodcastMetadata;
  private s3Storage: S3StorageBackend | null;
  private feedKey: string; // e.g. 'podcast.xml'
  private feedUrl: string; // public URL for enclosure links

  constructor(
    podcast: PodcastMetadata,
    s3Storage: S3StorageBackend | null,
    feedUrl: string,
    feedKey: string = 'podcast.xml'
  ) {
    this.podcast = podcast;
    this.s3Storage = s3Storage;
    this.feedUrl = feedUrl;
    this.feedKey = feedKey;
  }

  async addEpisode(
    feedUrl: string,
    episode: EpisodeMetadata,
    media: { url: string; lengthBytes: number; mimeType: string }
  ): Promise<FeedResult> {
    let existingXml: string | null = null;
    let currentEtag: string | undefined;
    let isCreate = true;

    if (this.s3Storage) {
      // S3 mode: fetch feed via S3 GET
      try {
        const getRes = await this.s3Storage.client.send(new GetObjectCommand({
          Bucket: this.s3Storage.config.bucket,
          Key: this.feedKey,
        }));
        if (getRes.Body) {
          const chunks: Buffer[] = [];
          for await (const chunk of getRes.Body as AsyncIterable<Buffer>) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          if (new TextEncoder().encode(body).length > MAX_FEED_XML_SIZE) {
            throw new FeedError('rss_fetch_failed', 'feed exceeds maximum size');
          }
          existingXml = body;
          currentEtag = getRes.ETag ?? undefined;
          isCreate = false;
        }
      } catch (err: unknown) {
        const errName = (err as { name?: string }).name;
        const errCode = (err as { code?: string }).code;
        if (errName !== 'NoSuchKey' && errCode !== 'NoSuchKey' && errName !== 'NotFound' && errCode !== 'NotFound') {
          throw new FeedError('rss_fetch_failed', `GET error: ${(err as Error).message}`);
        }
      }
    } else {
      // HTTP mode (RSS-only): fetch feed via fetch()
      try {
        const res = await fetch(feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.status === 404) {
          // Feed doesn't exist yet — create it
        } else if (res.ok) {
          const body = await res.text();
          if (new TextEncoder().encode(body).length > MAX_FEED_XML_SIZE) {
            throw new FeedError('rss_fetch_failed', 'feed exceeds maximum size');
          }
          existingXml = body;
          currentEtag = res.headers.get('etag') ?? undefined;
          isCreate = false;
        } else {
          // Non-404 non-ok response (403, 500, etc.) — treat as fetch failure
          throw new FeedError('rss_fetch_failed', `GET returned ${res.status}`);
        }
      } catch (err: unknown) {
        throw new FeedError('rss_fetch_failed', `GET error: ${(err as Error).message}`);
      }
    }

    let xml: string;
    if (existingXml) {
      xml = await this.updateFeed(existingXml, episode, media);
    } else {
      xml = this.createFeed(episode, media);
    }

    // Retry loop for concurrency (412/409)
    let mode: 'create' | 'update' = isCreate ? 'create' : 'update';
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (this.s3Storage) {
          await this.s3Storage.putString(this.feedKey, xml, 'application/rss+xml', currentEtag, mode === 'create');
        } else {
          await this.putWithRetry(feedUrl, xml, currentEtag, mode === 'create', episode, media);
        }
        return { feedUrl, episodeGuid: episode.guid };
      } catch (err: unknown) {
        const e = err as { name?: string; code?: string; message?: string };
        // Preserve FeedError codes
        if (e instanceof FeedError) throw e;
        const errCode = e.code ?? e.name;
        const httpStatus = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        const isConflict = httpStatus === 409 || httpStatus === 412 ||
          errCode === 'Conflict' || errCode === 'ConditionalRequestConflict' ||
          errCode === '409' || errCode === 'PreconditionFailed';
        if (isConflict) {
          if (attempt === MAX_RETRIES - 1) {
            throw new FeedError(mode === 'create' ? 'rss_create_failed' : 'rss_update_failed', `conflict: ${e.message}`);
          }
          // Re-fetch the feed
          let fetchedXml: string;
          let newEtag: string | undefined;
          try {
            if (this.s3Storage) {
              const getRes = await this.s3Storage.client.send(new GetObjectCommand({
                Bucket: this.s3Storage.config.bucket,
                Key: this.feedKey,
              }));
              if (!getRes.Body) throw new FeedError('rss_update_failed', 'feed disappeared during retry');
              const chunks: Buffer[] = [];
              for await (const chunk of getRes.Body as AsyncIterable<Buffer>) {
                chunks.push(chunk);
              }
              fetchedXml = Buffer.concat(chunks).toString('utf8');
              newEtag = getRes.ETag ?? undefined;
            } else {
              const getRes = await fetch(feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
              if (!getRes.ok) throw new FeedError('rss_update_failed', `feed disappeared during retry: ${getRes.status}`);
              fetchedXml = await getRes.text();
              newEtag = getRes.headers.get('etag') ?? undefined;
            }
          } catch {
            throw new FeedError('rss_fetch_failed', 'failed to re-fetch feed during retry');
          }
          if (new TextEncoder().encode(fetchedXml).length > MAX_FEED_XML_SIZE) {
            throw new FeedError('rss_fetch_failed', 'feed exceeds maximum size');
          }
          currentEtag = newEtag;
          mode = 'update';
          xml = await this.updateFeed(fetchedXml, episode, media);
        } else {
          throw new FeedError(mode === 'create' ? 'rss_create_failed' : 'rss_update_failed', e.message ?? String(err));
        }
      }
    }

    return { feedUrl, episodeGuid: episode.guid };
  }

  /**
   * PUT with ETag retry loop for HTTP mode (RSS-only).
   * Passes episode and media into the retry merge so the original item is preserved.
   */
  private async putWithRetry(
    feedUrl: string,
    xml: string,
    etag: string | undefined,
    isCreate: boolean,
    episode?: EpisodeMetadata,
    media?: { url: string; lengthBytes: number; mimeType: string }
  ): Promise<void> {
    let mode: 'create' | 'update' = isCreate ? 'create' : 'update';
    let currentEtag: string | undefined = etag;
    let currentXml: string = xml;

    for (let attempt = 0; attempt < MAX_RETRY_COUNT; attempt++) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/rss+xml',
      };

      if (mode === 'create' && !currentEtag) {
        headers['If-None-Match'] = '*';
      } else if (mode === 'update' && currentEtag) {
        headers['If-Match'] = currentEtag;
      }

      let fetchRes: Response;
      try {
        fetchRes = await fetch(feedUrl, {
          method: 'PUT',
          headers,
          body: currentXml,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        const modeCode = mode === 'create' ? 'rss_create_failed' : 'rss_update_failed';
        throw new FeedError(modeCode, `network error: ${(err as Error).message}`);
      }

      if (fetchRes.status >= 200 && fetchRes.status < 300) {
        return;
      }

      if (fetchRes.status === 404) {
        const modeCode = mode === 'create' ? 'rss_create_failed' : 'rss_update_failed';
        throw new FeedError(modeCode, 'feed not found');
      }

      if (fetchRes.status === 412 || fetchRes.status === 409) {
        if (attempt === MAX_RETRY_COUNT - 1) {
          const modeCode = mode === 'create' ? 'rss_create_failed' : 'rss_update_failed';
          throw new FeedError(modeCode, `conflict: ${fetchRes.status}`);
        }
        let getRes: Response;
        try {
          getRes = await fetch(feedUrl, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
        } catch (err) {
          throw new FeedError('rss_fetch_failed', `network error during re-fetch: ${(err as Error).message}`);
        }

        if (getRes.status === 200) {
          let fetchedXml: string;
          try {
            fetchedXml = await getRes.text();
            if (new TextEncoder().encode(fetchedXml).length > MAX_FEED_XML_SIZE) {
              throw new FeedError('rss_fetch_failed', 'feed exceeds maximum size');
            }
          } catch (err) {
            throw new FeedError('rss_fetch_failed', `body read error: ${(err as Error).message}`);
          }
          currentEtag = getRes.headers.get('etag') ?? undefined;
          // Pass the original episode/media into the retry merge so the requested item is preserved
          const mergeEpisode = episode ?? { title: '', description: '', guid: '', publishedAt: new Date().toISOString() };
          const mergeMedia = media ?? { url: '', lengthBytes: 0, mimeType: '' };
          let mergedXml: string;
          try {
            mergedXml = await this.updateFeed(fetchedXml, mergeEpisode, mergeMedia);
          } catch (err) {
            if (err instanceof FeedError) throw err;
            throw new FeedError('rss_update_failed', `merge error: ${(err as Error).message}`);
          }
          currentXml = mergedXml;
          mode = 'update';
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
          continue;
        }

        if (getRes.status === 404) {
          if (mode === 'update') {
            throw new FeedError('rss_update_failed', 'feed deleted during update');
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
          continue;
        }

        throw new FeedError('rss_fetch_failed', `GET returned ${getRes.status}`);
      }

      const modeCode = mode === 'create' ? 'rss_create_failed' : 'rss_update_failed';
      throw new FeedError(modeCode, `PUT returned ${fetchRes.status}`);
    }

    const finalCode = mode === 'create' ? 'rss_create_failed' : 'rss_update_failed';
    throw new FeedError(finalCode, 'max retries exceeded');
  }

  /**
   * Build a brand-new RSS feed from podcast metadata + one episode.
   */
  createFeed(episode: EpisodeMetadata, media: { url: string; lengthBytes: number; mimeType: string }): string {
    const now = new Date();
    const nowRFC822 = toRFC822(now);
    const currentYear = now.getFullYear();
    const rss = {
      rss: {
        $: { version: '2.0', 'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd', 'xmlns:dc': 'http://purl.org/dc/elements/1.1/', 'xmlns:content': 'http://purl.org/rss/1.0/modules/content/' },
        channel: {
          title: this.podcast.title,
          link: this.podcast.link,
          description: this.podcast.description,
          language: this.podcast.language,
          copyright: `Copyright ${currentYear} ${this.podcast.author}`,
          managingEditor: this.podcast.author,
          webMaster: this.podcast.author,
          lastBuildDate: nowRFC822,
          pubDate: nowRFC822,
          ttl: '60',
          'dc:creator': this.podcast.author,
          'itunes:author': this.podcast.author,
          'itunes:explicit': 'false',
          'itunes:type': 'episodic',
          'itunes:subtitle': truncateAtWord(this.podcast.description, 4000, true),
          'itunes:owner': { name: this.podcast.author },
          item: this.buildItem(episode, media),
          category: this.podcast.categories,
          'itunes:category': this.podcast.categories.map((c) => ({ $: { text: c } })),
        },
      },
    };
    return new Builder(BUILDER_OPTS).buildObject(rss);
  }

  /**
   * Update an existing feed by appending an episode item.
   */
  async updateFeed(existingXml: string, episode: EpisodeMetadata, media: { url: string; lengthBytes: number; mimeType: string }): Promise<string> {
    const parsed = await parseStringPromise(existingXml, PARSER_OPTS);

    // Namespace repair — ensure xmlns declarations are present on the root
    parsed.rss.$ ??= {};
    const ns = parsed.rss.$;
    if (!ns['xmlns:itunes']) ns['xmlns:itunes'] = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
    if (!ns['xmlns:dc']) ns['xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
    if (!ns['xmlns:content']) ns['xmlns:content'] = 'http://purl.org/rss/1.0/modules/content/';

    // Get the first channel and its first item
    let channel: Record<string, unknown>;
    if (typeof parsed.rss.channel === 'string') {
      channel = {};
      parsed.rss.channel = channel;
    } else if (Array.isArray(parsed.rss.channel)) {
      const first = parsed.rss.channel[0];
      if (typeof first === 'string') {
        // xml2js may return [''] for empty <channel/>
        channel = {};
        parsed.rss.channel[0] = channel;
      } else {
        channel = first as Record<string, unknown>;
      }
    } else {
      channel = parsed.rss.channel as Record<string, unknown>;
    }
    const items = Array.isArray(channel?.item) ? channel.item : (channel?.item ? [channel.item] : []);

    // Check for duplicate GUID across all items
    for (const item of items) {
      const guid = extractGuid(item);
      if (guid && guid === episode.guid) {
        throw new FeedError('rss_duplicate_guid', `guid "${episode.guid}" already exists in feed`);
      }
    }

    const newItem = this.buildItem(episode, media);

    if (Array.isArray(channel?.item)) {
      channel.item = [...channel.item, newItem];
    } else if (channel?.item) {
      channel.item = [channel.item, newItem];
    } else {
      channel.item = [newItem];
    }

    return new Builder(BUILDER_OPTS).buildObject(parsed);
  }

  /**
   * Build an RSS <item> element object for xml2js Builder.
   */
  private buildItem(
    episode: EpisodeMetadata,
    media: { url: string; lengthBytes: number; mimeType: string }
  ): Record<string, unknown> {
    const item: Record<string, unknown> = {
      title: episode.title,
      link: media.url,
      guid: {
        $: { isPermaLink: 'false' },
        _: episode.guid,
      },
      description: episode.description,
      pubDate: toRFC822(new Date(episode.publishedAt)),
      enclosure: {
        $: {
          url: media.url,
          type: 'audio/mpeg',
          length: String(media.lengthBytes),
        },
      },
      'content:encoded': episode.description,
      'itunes:title': episode.title,
      'itunes:description': truncateAtWord(episode.description, 4000, false),
      'itunes:author': this.podcast.author,
    };

    if (episode.episodeNumber !== undefined) {
      item['itunes:episode'] = String(episode.episodeNumber);
    }
    if (episode.season !== undefined) {
      item['itunes:season'] = String(episode.season);
    }
    if (episode.durationSeconds !== undefined) {
      item['itunes:duration'] = formatDuration(episode.durationSeconds);
    }
    // 'itunes:explicit' placed last to match the exact template order.
    item['itunes:explicit'] = 'false';

    return item;
  }
}

/**
 * Error with a stable `.code` property for discriminated error handling.
 */
export class FeedError extends Error {
  readonly code: FeedErrorCode;

  constructor(code: FeedErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'FeedError';
    this.code = code;
  }
}

export function toRFC822(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayName = days[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} GMT`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractGuid(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  if (!item?.guid) return undefined;

  // Handle array of strings (xml2js wraps text content in arrays)
  if (Array.isArray(item.guid)) {
    const first = item.guid[0];
    if (typeof first === 'string') return first;
    if (typeof first === 'object' && first !== null) {
      const guidObj = first as Record<string, unknown>;
      return (guidObj['_'] as string | undefined) ?? ((guidObj['$'] as Record<string, unknown>)?.['_'] as string | undefined);
    }
  }

  // Handle object with $_ (xml2js attribute syntax)
  if (typeof item.guid === 'object' && item.guid !== null) {
    const guidObj = item.guid as Record<string, unknown>;
    return (guidObj['_'] as string | undefined) ?? ((guidObj['$'] as Record<string, unknown>)?.['_'] as string | undefined);
  }

  // Handle plain string
  if (typeof item.guid === 'string') return item.guid;

  return undefined;
}

function truncateAtWord(text: string, maxLength: number, includeEllipsis?: boolean): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const final = lastSpace > maxLength * 0.5 ? truncated.slice(0, lastSpace) : truncated;
  return includeEllipsis ? final + '...' : final;
}
