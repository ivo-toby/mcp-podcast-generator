import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { S3StorageBackend } from '../../src/storage/s3-storage.js';
import { validateS3Config, FatalError } from '../../src/storage/storage-types.js';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Module factory — must be inline because vi.mock is hoisted
// ---------------------------------------------------------------------------
const sendMock = vi.fn().mockResolvedValue({ ETag: '"abc123"' });
let sentCommands: unknown[] = [];

vi.mock(
  '@aws-sdk/client-s3',
  () => {
    const sendMockLocal = vi.fn().mockResolvedValue({ ETag: '"abc123"' });
    const sentCommandsLocal: unknown[] = [];
    (globalThis as Record<string, unknown>).__sendMock = sendMockLocal;
    (globalThis as Record<string, unknown>).__sentCommands = sentCommandsLocal;

    class S3ClientMock {
      send = sendMockLocal;
      config: Record<string, unknown>;
      constructor(opts: Record<string, unknown>) {
        this.config = opts;
      }
    }
    class PutObjectCommandMock {
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
        sentCommandsLocal.push(input);
      }
    }
    return { S3Client: S3ClientMock, PutObjectCommand: PutObjectCommandMock };
  }
);

// Access mocked values
const getSendMock = () => (globalThis as Record<string, unknown>).__sendMock as ReturnType<typeof vi.fn>;
const getSentCommands = () => (globalThis as Record<string, unknown>).__sentCommands as unknown[];

describe('S3StorageBackend', () => {
  const originalEnv = { ...process.env };
  let tmpPath: string;

  beforeEach(() => {
    const sc = getSentCommands() as unknown[];
    while (sc.length > 0) sc.pop();
    getSendMock().mockClear();

    tmpPath = `/tmp/s3-test-${Date.now()}.mp3`;
    fs.writeFileSync(tmpPath, 'fake-audio-content');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  });

  describe('upload', () => {
    it('uploads file and returns correct MediaAsset', async () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';

      const config = validateS3Config();
      expect(config.enabled).toBe(true);
      expect(config.config).not.toBeNull();

      const s3Backend = new S3StorageBackend(config.config!);
      const result = await s3Backend.upload(tmpPath, 'episodes/episode.mp3');

      expect(result.url).toBe('https://cdn.example.com/episodes/episode.mp3');
      expect(result.lengthBytes).toBeGreaterThan(0);
      expect(result.mimeType).toBe('audio/mpeg');
    });

    it('constructs PutObjectCommand with correct params', async () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';

      const config = validateS3Config();
      expect(config.enabled).toBe(true);
      expect(config.config).not.toBeNull();

      const s3Backend = new S3StorageBackend(config.config!);
      await s3Backend.upload(tmpPath, 'episodes/episode.mp3');

      const sc = getSentCommands() as unknown[];
      expect(sc).toHaveLength(1);
      const input = sc[0] as Record<string, unknown>;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Key).toBe('episodes/episode.mp3');
      expect(input.ContentType).toBe('audio/mpeg');
      expect(input.ContentLength).toBe(fs.statSync(tmpPath).size);
    });

    it('encodes filename in public URL', async () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';

      const config = validateS3Config();
      expect(config.enabled).toBe(true);
      expect(config.config).not.toBeNull();

      const s3Backend = new S3StorageBackend(config.config!);
      const result = await s3Backend.upload(tmpPath, 'episodes/my episode.mp3');
      expect(result.url).toBe('https://cdn.example.com/episodes/my%20episode.mp3');
    });

    it('uses raw filename as S3 key (SDK handles wire encoding)', async () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';

      const config = validateS3Config();
      expect(config.enabled).toBe(true);
      expect(config.config).not.toBeNull();

      const s3Backend = new S3StorageBackend(config.config!);
      await s3Backend.upload(tmpPath, 'episodes/episode.mp3');

      const sc = getSentCommands() as unknown[];
      const input = sc[0] as Record<string, unknown>;
      expect(input.Key).toBe('episodes/episode.mp3');
    });


  });

  describe('validateS3Config (S3-specific tests)', () => {
    it('returns disabled when no S3 vars set', () => {
      const result = validateS3Config();
      expect(result.enabled).toBe(false);
      expect(result.config).toBeNull();
    });

    it('throws on partial config (3 of 5 vars)', () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_BUCKET = 'my-bucket';
      expect(() => validateS3Config()).toThrow(FatalError);
    });

    it('throws on invalid S3_ENDPOINT URL', () => {
      process.env.S3_ENDPOINT = 'not-a-url';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'secret';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      expect(() => validateS3Config()).toThrow(FatalError);
    });

    it('defaults region to us-east-1 when absent', () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      const result = validateS3Config();
      expect(result.config!.region).toBe('us-east-1');
    });

    it('uses S3_REGION when set', () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      process.env.S3_REGION = 'eu-west-1';
      const result = validateS3Config();
      expect(result.config!.region).toBe('eu-west-1');
    });

    it('S3_FORCE_PATH_STYLE only when value is "true"', () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      process.env.S3_FORCE_PATH_STYLE = 'false';
      const result = validateS3Config();
      expect(result.config!.forcePathStyle).toBe(false);
    });

    it('S3_FORCE_PATH_STYLE=true enables path style', () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      const result = validateS3Config();
      expect(result.config!.forcePathStyle).toBe(true);
    });
  });
});
