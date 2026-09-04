import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
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
  private _client: S3Client;
  private _config: S3Config;

  public get client(): S3Client { return this._client; }
  public get config(): S3Config { return this._config; }

  constructor(config: S3Config) {
    this._config = config;
    this._client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
      requestHandler: new NodeHttpHandler({
        requestTimeout: 300_000, // 5 minutes — prevents indefinite hangs on slow connections
      }),
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

    // Encode every key segment for the public URL.
    // The key (e.g. `episodes/episode.mp3`) maps directly to the URL path.
    const encodedSegments = key.split('/').map(encodeURIComponent);
    const url = `${this.config.publicUrl}/${encodedSegments.join('/')}`;

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

  /**
   * Put a string (e.g. RSS XML) directly to S3.
   * Used for feed management.
   */
  async putString(key: string, body: string, contentType: string, etag?: string, isCreate?: boolean): Promise<void> {
    const encodedSegments = key.split('/').map(encodeURIComponent);
    const url = `${this.config.publicUrl}/${encodedSegments.join('/')}`;

    const putParams: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    };

    // IfMatch for updates, IfNoneMatch for creates
    if (isCreate) {
      putParams.IfNoneMatch = '*';
    } else if (etag) {
      putParams.IfMatch = etag;
    }

    await this.client.send(new PutObjectCommand(putParams));

    log.info({ key: this.config.bucket + '/' + key, url }, 'String uploaded');
  }
}
