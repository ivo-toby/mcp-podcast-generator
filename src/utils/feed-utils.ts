import type { S3Config } from '../storage/storage-types.js';

/**
 * Derive an S3 key from an RSS feed URL.
 *
 * Strips the S3 public URL origin/path prefix from the feed URL to compute the relative path.
 * Returns an empty string if the feed URL origin does not match S3_PUBLIC_URL.
 * Returns 'podcast.xml' as a fallback when the relative path is empty.
 */
export function deriveFeedKey(feedUrl: string, s3Config: S3Config | null): string {
  try {
    const feedU = new URL(feedUrl);
    if (!s3Config) {
      // RSS-only (no S3) — use the feed URL pathname directly
      let path = feedU.pathname.replace(/\/*$/, '');
      if (path.startsWith('/')) path = path.slice(1);
      return path || 'podcast.xml';
    }
    const pubU = new URL(s3Config.publicUrl.replace(/\/*$/, ''));
    // Validate origin matches
    if (feedU.origin !== pubU.origin) return '';
    const pubPath = pubU.pathname.replace(/\/*$/, '');
    const feedPath = feedU.pathname;
    // Strip the public URL prefix to get the relative path
    if (!feedPath.startsWith(pubPath)) return '';
    let relative = feedPath.slice(pubPath.length);
    // Ensure path boundary: after the prefix must be '/' or empty
    if (relative.length > 0 && relative[0] !== '/') return '';
    // Remove leading slash
    if (relative.startsWith('/')) relative = relative.slice(1);
    relative = relative.replace(/\/*$/, '');
    return relative || 'podcast.xml';
  } catch {
    return 'podcast.xml';
  }
}
