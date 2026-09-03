/**
 * Feed types and publish result structures.
 */

/** Metadata for a single podcast episode. */
export interface EpisodeMetadata {
  /** Episode title. */
  title: string;
  /** Episode description — plain text only, no HTML. */
  description: string;
  /** Unique identifier (defaults to outputFilename). */
  guid: string;
  /** RFC 3339 timestamp (defaults to now). */
  publishedAt: string;
  /** Episode number (positive integer). */
  episodeNumber?: number;
  /** Season number (positive integer). */
  season?: number;
  /** Duration in seconds — omitted if ffprobe failed. */
  durationSeconds?: number;
}

/** Podcast-wide metadata injected via constructor at startup. */
export interface PodcastMetadata {
  /** Podcast title (required by RSS 2.0). */
  title: string;
  /** Podcast website URL (required by RSS 2.0). */
  link: string;
  /** Podcast description — plain text only, no HTML. */
  description: string;
  /** Podcast author / publisher. */
  author: string;
  /** Podcast language (e.g. 'en-us'). */
  language: string;
  /** Podcast categories. */
  categories: string[];
}

/** Result from adding an episode to a feed. */
export interface FeedResult {
  feedUrl: string;
  episodeGuid: string;
}

/** A single stage of the publish pipeline. */
export type StageResult =
  | { status: 'succeeded'; s3Url?: string; feedUrl?: string }
  | {
      status: 'failed';
      errorCode: string;
      errorMessage: string;
    }
  | { status: 'skipped'; reason: string };

/**
 * Overall publish result — always returned, never throws.
 */
export interface PublishResult {
  /** True if at least one stage succeeded. */
  success: boolean;
  /** Per-stage status — always present. */
  stages: {
    s3: StageResult;
    rss: StageResult;
  };
  /** File size in bytes — present if stat probe succeeded. */
  fileSizeBytes?: number;
  /** Duration in seconds — present if ffprobe probe succeeded. */
  durationSeconds?: number;
  /** True when fs.stat failed (even if stages succeeded). */
  probeStatFailed?: boolean;
  /** True when ffprobe failed (even if stages succeeded). */
  probeFFprobeFailed?: boolean;
  /** Error code on overall failure — always errorCode (never error). */
  errorCode?: string;
}

/**
 * Stable error codes emitted by feed operations.
 *
 * Every FeedError must use one of these codes so callers can
 * discriminate without string comparison.
 */
export type FeedErrorCode =
  | 'rss_fetch_failed'
  | 'rss_create_failed'
  | 'rss_update_failed'
  | 'rss_duplicate_guid';

/**
 * Feed backend abstraction (S3, Podlove, Spotify, etc.).
 */
export interface FeedBackend {
  /**
   * Add or create an RSS episode entry.
   *
   * If the feed exists at `url`, fetch it, parse, check for duplicate GUID,
   * append an episode, and PUT back. If the feed doesn't exist (404),
   * create a new feed with podcast metadata + one episode.
   *
   * PodcastMetadata is injected via constructor; addEpisode receives only
   * the per-call episode data.
   */
  addEpisode(
    feedUrl: string,
    episode: EpisodeMetadata,
    media: { url: string; lengthBytes: number; mimeType: string }
  ): Promise<FeedResult>;
}
