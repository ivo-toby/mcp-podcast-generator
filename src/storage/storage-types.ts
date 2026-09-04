/**
 * Storage types and S3 configuration validation.
 */

export interface MediaAsset {
  /** Publicly reachable URL of the media file. */
  url: string;
  /** File size in bytes. */
  lengthBytes: number;
  /** MIME type (e.g. 'audio/mpeg'). */
  mimeType: string;
}

/**
 * Abstraction over a storage backend (S3, R2, CDN upload, etc.).
 * The feed layer receives MediaAsset — never an S3-specific value.
 */
export interface StorageBackend {
  /**
   * Upload a local file to storage.
   * Returns a MediaAsset with a publicly reachable URL.
   */
  upload(localPath: string, key: string): Promise<MediaAsset>;
}

/** S3 configuration parsed from environment variables. */
export interface S3Config {
  endpoint: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  forcePathStyle?: boolean;
}

/** Result of validating S3 environment variables. */
export type S3ValidationResult =
  | { config: null; enabled: false }
  | { config: S3Config; enabled: true };

/**
 * Validate S3 configuration from environment variables.
 *
 * All-or-none validation: if any one of the 5 required S3 variables is set,
 * then ALL 5 must be set — otherwise a `FatalError` is thrown.
 * If none are set, S3 is disabled.
 *
 * S3_REGION is optional and defaults to 'us-east-1' when absent but other
 * S3 variables are present.
 * S3_FORCE_PATH_STYLE is a separate boolean flag (only 'true' enables it;
 * setting only S3_FORCE_PATH_STYLE does NOT enable S3).
 */
export function validateS3Config(): S3ValidationResult {
  const hasAny =
    process.env.S3_ENDPOINT ||
    process.env.S3_ACCESS_KEY_ID ||
    process.env.S3_SECRET_ACCESS_KEY ||
    process.env.S3_BUCKET ||
    process.env.S3_PUBLIC_URL;

  if (!hasAny) {
    return { config: null, enabled: false };
  }

  // All 5 required variables must be present (non-empty string)
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  const publicUrl = process.env.S3_PUBLIC_URL;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    const present = [
      endpoint && 'S3_ENDPOINT',
      accessKeyId && 'S3_ACCESS_KEY_ID',
      secretAccessKey && 'S3_SECRET_ACCESS_KEY',
      bucket && 'S3_BUCKET',
      publicUrl && 'S3_PUBLIC_URL',
    ]
      .filter(Boolean)
      .join(', ');
    const missing = [
      !endpoint && 'S3_ENDPOINT',
      !accessKeyId && 'S3_ACCESS_KEY_ID',
      !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
      !bucket && 'S3_BUCKET',
      !publicUrl && 'S3_PUBLIC_URL',
    ]
      .filter(Boolean)
      .join(', ');
    throw new FatalError(
      `S3 config incomplete: present=[${present}], missing=[${missing}]. All 5 required variables must be set together.`
    );
  }

  // Validate endpoint is a valid URL
  try {
    new URL(endpoint);
  } catch {
    throw new FatalError(`S3_ENDPOINT "${endpoint}" is not a valid URL`);
  }

  // Normalize publicUrl: strip trailing slashes
  const normalizedPublicUrl = publicUrl.replace(/\/*$/, '');
  if (!normalizedPublicUrl) {
    throw new FatalError(`S3_PUBLIC_URL "${publicUrl}" resolves to an empty string after normalization`);
  }

  // Region defaults to us-east-1 when absent or empty
  const region = process.env.S3_REGION || 'us-east-1';

  // S3_FORCE_PATH_STYLE: only 'true' enables it
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

  return {
    config: {
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      bucket,
      publicUrl: normalizedPublicUrl,
      forcePathStyle,
    },
    enabled: true,
  };
}

/**
 * Thrown when required configuration is missing or invalid.
 * Fatal — the process should exit.
 */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}
