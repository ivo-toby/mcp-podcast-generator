import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { readFile } from 'fs/promises';
import type { S3Config, MediaAsset } from './storage-types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('s3-storage');

/**
 * S3-compatible storage backend.
 *
 * Uses a Buffer (readFileSync) to avoid AWS SDK v3 stream retry issue #5479:
 * passing a readable stream to PutObjectCommand will hang if a retry happens
 * because streams cannot be rewound.
 */
export class S3StorageBackend {
  private client: S3Client;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
  }

  /**
   * Upload a local file to S3.
   *
   * Key format: `episodes/${filename}` (raw — the SDK percent-encodes
   * key segments on the wire). The returned MediaAsset URL encodes the
   * filename for use in the public URL.
   */
  async upload(localPath: string, key: string): Promise<MediaAsset> {
    const buffer = await readFile(localPath);
    const contentType = 'audio/mpeg';

    // Extract filename from key for the public URL (key = `episodes/${filename}`)
    const filename = key.split('/').pop() || key;
    const encodedFilename = encodeURIComponent(filename);
    const url = `${this.config.publicUrl}/episodes/${encodedFilename}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.byteLength,
      })
    );

    log.info(
      { key: this.config.bucket + '/' + key, bytes: buffer.byteLength },
      'Upload completed'
    );

    return {
      url,
      lengthBytes: buffer.byteLength,
      mimeType: contentType,
    };
  }
}
