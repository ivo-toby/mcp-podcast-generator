import {
  Builder,
  Parser,
  parseStringPromise,
} from 'xml2js';
import type {
  FeedBackend,
  EpisodeMetadata,
  PodcastMetadata,
  FeedResult,
} from './feed-types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('rss-feed');

const MAX_RETRY_COUNT = 3; // 3 total PUT attempts = 2 retries
const RETRY_BACKOFF_MS = [100, 300];
const FETCH_TIMEOUT_MS = 10_000;

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
 * Shared xml2js parser options — XXE protection.
 */
const PARSER_OPTS = {
  whitelist: [],
  maxDepth: 100,
};

/**
 * RSS feed backend using xml2js for parsing and building XML.
 */
export class RssFeedBackend implements FeedBackend {
  private podcast: PodcastMetadata;

  constructor(podcast: PodcastMetadata) {
    this.podcast = podcast;
  }

  async addEpisode(
    feedUrl: string,
    episode: EpisodeMetadata,
    media: { url: string; lengthBytes: number; mimeType: string }
  ): Promise<FeedResult> {
    const fetchRes = await fetch(feedUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (fetchRes.status === 404) {
      // Feed doesn't exist — create it
      const xml = this.createFeed(episode, media);
      await this.putWithRetry(feedUrl, xml, undefined, true, episode, media);
      return { feedUrl, episodeGuid: episode.guid };
    }

    if (fetchRes.status === 200) {
      const existingXml = await fetchRes.text();
      const etag = fetchRes.headers.get('etag') ?? undefined;

      const xml = await this.updateFeed(existingXml, episode, media);
      await this.putWithRetry(feedUrl, xml, etag, false, episode, media);
      return { feedUrl, episodeGuid: episode.guid };
    }

    throw new FeedError(`rss_fetch_failed: unexpected status ${fetchRes.status}`);
  }

  /**
   * Build a brand-new RSS feed from podcast metadata + one episode.
   */
  createFeed(episode: EpisodeMetadata, media: { url: string; lengthBytes: number; mimeType: string }): string {
    const now = toRFC822(new Date());
    const currentYear = new Date().getFullYear();

    const rss: Record<string, unknown> = {
      rss: {
        $: {
          version: '2.0',
          'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd',
          'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
          'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
        },
        channel: [
          {
            title: this.podcast.title,
            link: this.podcast.link,
            description: this.podcast.description,
            language: this.podcast.language,
            copyright: `Copyright ${currentYear} ${this.podcast.author}`,
            managingEditor: this.podcast.author,
            webMaster: this.podcast.author,
            lastBuildDate: now,
            pubDate: now,
            ttl: '60',
            'dc:creator': this.podcast.author,
            category: this.podcast.categories,
            'itunes:author': this.podcast.author,
            'itunes:owner': {
              name: this.podcast.author,
            },
            'itunes:type': 'episodic',
            item: [
              this.buildItem(episode, media),
            ],
          },
        ],
      },
    };

    return new Builder(BUILDER_OPTS).buildObject(rss) as string;
  }

  /**
   * Parse existing XML, check for duplicate GUID, append a new episode.
   *
   * Returns the serialized XML string.
   */
  async updateFeed(
    existingXml: string,
    episode: EpisodeMetadata,
    media: { url: string; lengthBytes: number; mimeType: string }
  ): Promise<string> {
    const parsed = (await parseStringPromise(existingXml)) as any;

    const channel = parsed.rss?.channel?.[0];
    if (!channel) {
      throw new FeedError('rss_update_failed: parsed XML has no channel');
    }

    // Ensure items array exists (xml2js omits key when no <item> exists)
    channel.item = channel.item ?? [];

    // Check for duplicate GUID
    for (const item of channel.item) {
      const guid = extractGuid(item);
      if (guid === episode.guid) {
        throw new FeedError('rss_duplicate_guid');
      }
    }

    // Append new item
    channel.item.push(this.buildItem(episode, media));

    // Namespace repair — ensure xmlns declarations are present
    const ns = parsed.rss?.$ ?? {};
    if (!ns['xmlns:itunes']) ns['xmlns:itunes'] = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
    if (!ns['xmlns:dc']) ns['xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
    if (!ns['xmlns:content']) ns['xmlns:content'] = 'http://purl.org/rss/1.0/modules/content/';

    return new Builder(BUILDER_OPTS).buildObject(parsed) as string;
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
        '@_isPermaLink': 'false',
        _: episode.guid,
      },
      description: episode.description,
      pubDate: toRFC822(new Date(episode.publishedAt)),
      enclosure: {
        '@_url': media.url,
        '@_type': media.mimeType,
        '@_length': String(media.lengthBytes),
      },
      'content:encoded': episode.description,
      'itunes:title': episode.title,
      'itunes:description': truncateAtWord(episode.description, 4000),
      'itunes:author': this.podcast.author,
      'itunes:explicit': 'false',
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

    return item;
  }

  /**
   * PUT with ETag retry loop for concurrency safety.
   *
   * Up to 3 total PUT attempts (2 retries) with exponential backoff.
   * On 412/409, re-fetch the feed and retry the merge.
   */
  private async putWithRetry(
    feedUrl: string,
    xml: string,
    etag: string | undefined,
    isCreate: boolean,
    _episode: EpisodeMetadata,
    _media: { url: string; lengthBytes: number; mimeType: string }
  ): Promise<void> {
    let mode: 'create' | 'update' = isCreate ? 'create' : 'update';
    let currentEtag: string | undefined = etag;

    for (let attempt = 0; attempt < MAX_RETRY_COUNT; attempt++) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/rss+xml',
      };

      if (mode === 'update' && currentEtag) {
        headers['If-Match'] = currentEtag;
      } else {
        headers['If-None-Match'] = '*';
      }

      const fetchRes = await fetch(feedUrl, {
        method: 'PUT',
        headers,
        body: xml,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (fetchRes.status >= 200 && fetchRes.status < 300) {
        // Success
        return;
      }

      if (fetchRes.status === 404) {
        // Feed disappeared between GET and PUT
        if (mode === 'update') {
          throw new FeedError('rss_update_failed');
        }
        // In create mode, the feed still doesn't exist — just re-PUT
        continue;
      }

      if (fetchRes.status === 412 || fetchRes.status === 409) {
        // Concurrency conflict — re-fetch and retry
        const getRes = await fetch(feedUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (getRes.status === 200) {
          currentEtag = getRes.headers.get('etag') ?? undefined;
          const existingXml = await getRes.text();
          const updatedXml = await this.updateFeed(existingXml, _episode, _media);
          mode = 'update';
          // Continue the loop to retry the PUT
          continue;
        }

        if (getRes.status === 404) {
          // Feed was deleted during retry
          if (mode === 'update') {
            throw new FeedError('rss_update_failed');
          }
          // Create mode — feed still doesn't exist, continue retry loop
          continue;
        }

        // Other status on GET (500, etc.) — no valid feed to retry with
        throw new FeedError(`rss_fetch_failed: GET returned ${getRes.status}`);
      }

      // Other error status — give up
      throw new FeedError(`rss_${mode}_failed: PUT returned ${fetchRes.status}`);
    }

    // All retries exhausted
    throw new FeedError(`rss_${mode}_failed: max retries (${MAX_RETRY_COUNT}) exhausted`);
  }
}

/**
 * Error with a stable `.code` property for discriminated error handling.
 */
export class FeedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'FeedError';
    this.code = code;
  }
}

/**
 * Extract the GUID text value from an xml2js-parsed <guid> node.
 *
 * Handles both plain text GUIDs (`<guid>value</guid>`) and attributed
 * GUIDs (`<guid isPermaLink="false">value</guid>`).
 */
function extractGuid(item: Record<string, unknown>): string | undefined {
  const node = (item.guid as any)?.[0];
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') return (node as any)?._;
  return undefined;
}

/**
 * Format seconds as HH:MM:SS.
 */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return `${hh}:${mm}:${ss}`;
}

/**
 * Convert a Date to RFC 822 format in UTC.
 *
 * RFC 822 example: "Mon, 01 Jan 2026 10:30:00 GMT"
 */
export function toRFC822(date: Date): string {
  return date.toUTCString();
}

/**
 * Truncate a string to `maxLength` characters at the nearest word boundary.
 *
 * Splits at the last whitespace before the limit so that partial words
 * are not emitted.
 */
function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  let truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    truncated = truncated.slice(0, lastSpace);
  }
  return truncated + '...';
}
