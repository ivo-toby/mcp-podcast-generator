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

/**
 * RSS feed backend using xml2js for parsing and building XML.
 * Uses the S3 storage backend for feed read/write operations.
 */
export class RssFeedBackend implements FeedBackend {
  private podcast: PodcastMetadata;
  private s3Storage: S3StorageBackend;
  private feedKey: string; // e.g. 'podcast.xml'
  private feedUrl: string; // public URL for enclosure links

  constructor(
    podcast: PodcastMetadata,
    s3Storage: S3StorageBackend,
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

    // Fetch existing feed via S3
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
      }
    } catch (err: unknown) {
      const errName = (err as { name?: string }).name;
      const errCode = (err as { code?: string }).code;
      if (errName !== 'NoSuchKey' && errCode !== 'NoSuchKey' && errName !== 'NotFound' && errCode !== 'NotFound') {
        throw new FeedError('rss_fetch_failed', `GET error: ${(err as Error).message}`);
      }
    }

    let xml: string;
    if (existingXml) {
      xml = await this.updateFeed(existingXml, episode, media);
    } else {
      xml = this.createFeed(episode, media);
    }

    await this.s3Storage.putString(this.feedKey, xml, 'application/rss+xml');

    return { feedUrl, episodeGuid: episode.guid };
  }

  /**
   * Build a brand-new RSS feed from podcast metadata + one episode.
   */
  createFeed(episode: EpisodeMetadata, media: { url: string; lengthBytes: number; mimeType: string }): string {
    const rss = {
      rss: {
        $: { version: '2.0', 'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd', 'xmlns:content': 'http://purl.org/rss/1.0/modules/content/' },
        channel: {
          title: this.podcast.title,
          link: this.podcast.link,
          description: this.podcast.description,
          language: this.podcast.language,
          generator: 'mcp-podcast-generator',
          'itunes:author': this.podcast.author,
          'itunes:explicit': 'false',
          'itunes:type': 'episodic',
          'itunes:email': this.podcast.author,
          image: { link: this.podcast.link },
          'itunes:subtitle': truncateAtWord(this.podcast.description, 4000, true),
          item: this.buildItem(episode, media),
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
    
    // Get the first channel and its first item
    const channel = Array.isArray(parsed.rss.channel) ? parsed.rss.channel[0] : parsed.rss.channel;
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
