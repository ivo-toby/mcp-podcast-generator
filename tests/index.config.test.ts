import { describe, it, expect, afterEach, vi } from 'vitest';
import { validateS3Config, FatalError } from '../src/storage/storage-types.js';

describe('Configuration validation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore all env vars to original state
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe('validateS3Config', () => {
    it('returns disabled when no S3 vars are set', () => {
      // Clear any S3 vars from .env
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.S3_BUCKET;
      delete process.env.S3_PUBLIC_URL;
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      const result = validateS3Config();
      expect(result.enabled).toBe(false);
      expect(result.config).toBeNull();
    });

    it('throws FatalError when only S3_ENDPOINT is set (partial config)', () => {
      // Clear any S3 vars from .env first
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.S3_BUCKET;
      delete process.env.S3_PUBLIC_URL;
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'https://s3.example.com';
      expect(() => validateS3Config()).toThrow(FatalError);
    });

    it('throws FatalError when 3 of 5 required vars are set', () => {
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.S3_PUBLIC_URL;
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_BUCKET = 'my-bucket';
      expect(() => validateS3Config()).toThrow(FatalError);
    });

    it('throws FatalError when all 5 vars are set but endpoint is invalid', () => {
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'not-a-url';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      expect(() => validateS3Config()).toThrow(FatalError);
    });

    it('returns enabled config when all 5 vars are set', () => {
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      const result = validateS3Config();
      expect(result.enabled).toBe(true);
      expect(result.config).not.toBeNull();
      expect(result.config!.endpoint).toBe('https://s3.example.com');
      expect(result.config!.bucket).toBe('my-bucket');
    });

    it('defaults region to us-east-1 when absent', () => {
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      const result = validateS3Config();
      expect(result.config!.region).toBe('us-east-1');
    });

    it('uses custom region when S3_REGION is set', () => {
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com';
      process.env.S3_REGION = 'eu-west-1';
      const result = validateS3Config();
      expect(result.config!.region).toBe('eu-west-1');
    });

    it('does NOT enable S3 when only S3_FORCE_PATH_STYLE is set', () => {
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.S3_BUCKET;
      delete process.env.S3_PUBLIC_URL;
      delete process.env.S3_REGION;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_FORCE_PATH_STYLE = 'true';
      const result = validateS3Config();
      expect(result.enabled).toBe(false);
    });

    it('strips trailing slashes from publicUrl', () => {
      delete process.env.S3_REGION;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_FEED_BUCKET;

      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_PUBLIC_URL = 'https://cdn.example.com/';
      const result = validateS3Config();
      expect(result.config!.publicUrl).toBe('https://cdn.example.com');
    });
  });
});
