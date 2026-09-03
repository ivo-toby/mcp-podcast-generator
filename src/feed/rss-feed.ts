import {
  Builder,
  parseStringPromise,
} from 'xml2js';
import type {
  FeedBackend,
  EpisodeMetadata,
  PodcastMetadata,
  FeedResult,
} from './feed-types.js';
const MAX_RETRY_COUNT = 3;
const RETRY_BACKOFF_MS = [100, 300]; // 2 retries: attempt 0→1 = 100ms, attempt 1→2 = 300ms
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
 * Shared xml2js parser options.
 *
 * feed URLs are operator-configured (not user-supplied), so XXE risk is low.
 * xml2js 0.6 ignores whitelist/maxDepth — we validate input size instead.
 */
const PARSER_OPTS: import('xml2js').ParserOptions = {};
const MAX_FEED_XML_SIZE = 2 * 1024 * 1024; // 2 MB

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
    let fetchRes: Response;
    try {
      fetchRes = await fetch(feedUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new FeedError('rss_fetch_failed', `network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (fetchRes.status === 404) {
      // Feed doesn't exist — create it
      let xml: string;
      try {
        xml = this.createFeed(episode, media);
      } catch (err) {
        throw new FeedError('rss_create_failed', `serialization error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.putWithRetry(feedUrl, xml, undefined, true, episode, media);
      return { feedUrl, episodeGuid: episode.guid };
    }

    if (fetchRes.status === 200) {
      let existingXml: string;
      try {
        const body = await fetchRes.text();
        if (new TextEncoder().encode(body).length > MAX_FEED_XML_SIZE) {
          throw new FeedError('rss_fetch_failed', 'feed exceeds maximum size');
        }
        existingXml = body;
      } catch (err) {
        throw new FeedError('rss_fetch_failed', `body read error: ${err instanceof Error ? err.message : String(err)}`);
      }
      const etag = fetchRes.headers.get('etag') ?? undefined;

      const xml = await this.updateFeed(existingXml, episode, media);
      await this.putWithRetry(feedUrl, xml, etag, false, episode, media);
      return { feedUrl, episodeGuid: episode.guid };
    }

    throw new FeedError('rss_fetch_failed', `unexpected status ${fetchRes.status}`);
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

    let xml: string;
    try {
      xml = new Builder(BUILDER_OPTS).buildObject(rss) as string;
    } catch (err) {
      throw new FeedError('rss_create_failed', `build error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return xml;
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
    let parsed: any;
    try {
      parsed = await parseStringPromise(existingXml, PARSER_OPTS as any);
    } catch {
      throw new FeedError('rss_update_failed', 'parse error');
    }

    const channel = parsed?.rss?.channel?.[0];
    if (!channel) {
      throw new FeedError('rss_update_failed', 'no channel');
    }

    // Ensure items array exists (xml2js omits key when no <item> exists)
    channel.item = channel.item ?? [];

    // Check for duplicate GUID
    for (const item of channel.item) {
      const guid = extractGuid(item);
      if (guid === episode.guid) {
        throw new FeedError('rss_duplicate_guid', 'duplicate GUID found');
      }
    }

    // Append new item
    channel.item.push(this.buildItem(episode, media));

    // Namespace repair — ensure xmlns declarations are present on the actual root
    parsed.rss.$ ??= {};
    const ns = parsed.rss.$;
    if (!ns['xmlns:itunes']) ns['xmlns:itunes'] = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
    if (!ns['xmlns:dc']) ns['xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
    if (!ns['xmlns:content']) ns['xmlns:content'] = 'http://purl.org/rss/1.0/modules/content/';

    let xml: string;
    try {
      xml = new Builder(BUILDER_OPTS).buildObject(parsed) as string;
    } catch (err) {
      throw new FeedError('rss_update_failed', `build error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return xml;
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
    let currentXml: string | undefined = xml; // mutable — updated on 409/412 re-merge

    for (let attempt = 0; attempt < MAX_RETRY_COUNT; attempt++) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/rss+xml',
      };

      // Only send If-None-Match in create mode.
      // In update mode without ETag: unconditional PUT (last-write-wins).
      if (mode === 'create' && !currentEtag) {
        headers['If-None-Match'] = '*';
      } else if (mode === 'update' && currentEtag) {
        headers['If-Match'] = currentEtag;
      }
      // else: update mode without ETag → no precondition header (last-write-wins)

      let fetchRes: Response;
      try {
        fetchRes = await fetch(feedUrl, {
          method: 'PUT',
          headers,
          body: currentXml ?? xml,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        throw new FeedError(`rss_${mode}_failed`, `network error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (fetchRes.status >= 200 && fetchRes.status < 300) {
        // Success
        return;
      }

      if (fetchRes.status === 404) {
        // Feed disappeared between GET and PUT — always fail.
        // Only a 404 from the conflict re-fetch is handled below.
        throw new FeedError(`rss_${mode}_failed`, 'feed not found');
      }

      if (fetchRes.status === 412 || fetchRes.status === 409) {
        // Concurrency conflict — re-fetch and retry.
        // On the final attempt, throw immediately (no retry remaining).
        if (attempt === MAX_RETRY_COUNT - 1) {
          throw new FeedError(`rss_${mode}_failed`, `conflict: ${fetchRes.status}`);
        }
        let getRes: Response;
        try {
          getRes = await fetch(feedUrl, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
        } catch (err) {
          throw new FeedError('rss_fetch_failed', `network error during re-fetch: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (getRes.status === 200) {
          let existingXml: string;
          try {
            const body = await getRes.text();
            if (new TextEncoder().encode(body).length > MAX_FEED_XML_SIZE) {
              throw new FeedError('rss_fetch_failed', 'feed exceeds maximum size');
            }
            existingXml = body;
          } catch (err) {
            throw new FeedError('rss_fetch_failed', `body read error: ${err instanceof Error ? err.message : String(err)}`);
          }
          currentEtag = getRes.headers.get('etag') ?? undefined;
          let mergedXml: string;
          try {
            mergedXml = await this.updateFeed(existingXml, _episode, _media);
          } catch (err) {
            // Preserve FeedError codes (e.g., rss_duplicate_guid) rather than masking them.
            if (err instanceof FeedError) throw err;
            throw new FeedError('rss_update_failed', `merge error: ${err instanceof Error ? err.message : String(err)}`);
          }
          currentXml = mergedXml;
          mode = 'update';
          // Continue the loop to retry the PUT
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
          continue;
        }

        if (getRes.status === 404) {
          // Feed was deleted during retry
          if (mode === 'update') {
            throw new FeedError('rss_update_failed', 'feed deleted during update');
          }
          // Create mode — feed still doesn't exist, continue retry loop
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
          continue;
        }

        // Other status on GET (500, etc.) — no valid feed to retry with
        throw new FeedError('rss_fetch_failed', `GET returned ${getRes.status}`);
      }

      // Other error status — give up
      throw new FeedError(`rss_${mode}_failed`, `PUT returned ${fetchRes.status}`);
    }

    // All retries exhausted — no further PUTs allowed.
    throw new FeedError(`rss_${mode}_failed`, 'max retries exceeded');
  }
}

/**
 * Error with a stable `.code` property for discriminated error handling.
 */
export class FeedError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
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
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

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
function truncateAtWord(text: string, maxLength: number, includeEllipsis?: boolean): string {
  if (text.length <= maxLength) return text;

  const ellipsis = includeEllipsis ? '...' : '';
  let truncated = text.slice(0, maxLength - ellipsis.length);
  // Find the last whitespace character scanning from the right.
  let lastWs = -1;
  for (let i = truncated.length - 1; i >= 0; i--) {
    if (/\s/.test(truncated[i])) {
      lastWs = i;
      break;
    }
  }
  if (lastWs > 0) {
    truncated = truncated.slice(0, lastWs);
  }
  return truncated + ellipsis;
}
