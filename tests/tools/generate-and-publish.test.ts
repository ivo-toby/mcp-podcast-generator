import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, expect, it, vi } from 'vitest';
import type { FeedBackend, PublishResult } from '../../src/feed/feed-types.js';
import type { StorageBackend } from '../../src/storage/storage-types.js';
import {
  GenerateAndPublishInput,
  createGenerateAndPublishExecutor,
} from '../../src/tools/generate-and-publish.js';
import { createPublishHandler } from '../../src/tools/publish-podcast.js';

const input = {
  type: 'single' as const,
  hosts: [{ name: 'Alex', voice: 'Charon' }],
  segments: [{ text: 'Hello world.' }],
  outputFilename: 'episode.mp3',
  episodeTitle: 'Episode one',
  episodeDescription: 'A description',
};

describe('generate_and_publish executor', () => {
  it('preserves generation defaults and the generation filename contract in the merged schema', () => {
    const parsed = GenerateAndPublishInput.parse(input);

    expect(parsed.outputFilename).toBe('episode.mp3');
    expect(parsed.fadeInDuration).toBe(2);
    expect(parsed.fadeOutDuration).toBe(3);
    expect(parsed.targetLufs).toBe(-16);
    expect(() => GenerateAndPublishInput.parse({ ...input, outputFilename: '' })).toThrow();
  });

  it('generates once, reports ordered stages, and passes only publishing fields to the publisher', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      outputPath: '/output/episode.mp3',
      durationSeconds: 42,
    });
    const publish = vi.fn().mockResolvedValue({
      success: true,
      stages: {
        s3: { status: 'succeeded', s3Url: 'https://cdn.example.com/episode.mp3' },
        rss: { status: 'skipped', reason: 'not configured' },
      },
    } satisfies PublishResult);
    const stages: string[] = [];

    const outcome = await createGenerateAndPublishExecutor(
      GenerateAndPublishInput.parse(input),
      { generate, publish },
    )((stage) => stages.push(stage));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      outputFilename: 'episode.mp3',
      episodeTitle: 'Episode one',
      episodeDescription: 'A description',
    }, expect.any(Function));
    expect(stages).toEqual(['generating', 'probing']);
    expect(outcome).toEqual({
      status: 'succeeded',
      result: {
        success: true,
        generation: { success: true, outputPath: '/output/episode.mp3', durationSeconds: 42 },
        publish: expect.objectContaining({ success: true }),
      },
    });
  });

  it('includes the generated-audio download URL when a public URL is supplied', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      outputPath: '/output/episode.mp3',
      durationSeconds: 42,
    });
    const publish = vi.fn().mockResolvedValue({
      success: true,
      stages: {
        s3: { status: 'succeeded', s3Url: 'https://cdn.example.com/episode.mp3' },
        rss: { status: 'skipped', reason: 'not configured' },
      },
    } satisfies PublishResult);

    const outcome = await createGenerateAndPublishExecutor(
      GenerateAndPublishInput.parse(input),
      { generate, publish },
      'https://public.example.com',
    )(() => {});

    expect(outcome).toEqual({
      status: 'succeeded',
      result: expect.objectContaining({
        success: true,
        downloadUrl: 'https://public.example.com/output/episode.mp3',
      }),
    });
  });

  it('treats a partial publish as success and preserves failed stage details', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      outputPath: '/output/episode.mp3',
      durationSeconds: 42,
    });
    const publish = vi.fn().mockResolvedValue({
      success: true,
      stages: {
        s3: { status: 'succeeded', s3Url: 'https://cdn.example.com/episode.mp3' },
        rss: { status: 'failed', errorCode: 'rss_update_failed', errorMessage: 'network' },
      },
    } satisfies PublishResult);

    const outcome = await createGenerateAndPublishExecutor(
      GenerateAndPublishInput.parse(input),
      { generate, publish },
      'https://public.example.com',
    )(() => {});

    expect(outcome).toMatchObject({
      status: 'succeeded',
      result: {
        success: true,
        downloadUrl: 'https://public.example.com/output/episode.mp3',
        publish: {
          success: true,
          stages: {
            s3: { status: 'succeeded' },
            rss: { status: 'failed', errorCode: 'rss_update_failed' },
          },
        },
      },
    });
  });

  it('does not publish after a generation rejection', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('generation failed'));
    const publish = vi.fn();
    const stages: string[] = [];

    await expect(
      createGenerateAndPublishExecutor(GenerateAndPublishInput.parse(input), { generate, publish })
        ((stage) => stages.push(stage)),
    ).rejects.toThrow('generation failed');

    expect(stages).toEqual(['generating']);
    expect(publish).not.toHaveBeenCalled();
  });

  it('retains the generated result in a controlled failure when publishing fails', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      outputPath: '/output/episode.mp3',
      durationSeconds: 42,
    });
    const publish = vi.fn().mockResolvedValue({
      success: false,
      errorCode: 'rss_update_failed',
      stages: {
        s3: { status: 'skipped', reason: 'not configured' },
        rss: { status: 'failed', errorCode: 'rss_update_failed', errorMessage: 'network' },
      },
    } satisfies PublishResult);

    const outcome = await createGenerateAndPublishExecutor(
      GenerateAndPublishInput.parse(input),
      { generate, publish },
      'https://public.example.com',
    )(() => {});

    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'rss_update_failed', message: 'Publishing failed' },
      result: {
        success: false,
        generation: { outputPath: '/output/episode.mp3' },
        publish: { success: false, errorCode: 'rss_update_failed' },
        downloadUrl: 'https://public.example.com/output/episode.mp3',
      },
    });
  });

  it('retains the no-destination error code on combined publish failure', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      outputPath: '/output/episode.mp3',
      durationSeconds: 42,
    });
    const publish = vi.fn().mockResolvedValue({
      success: false,
      errorCode: 'no_storage_or_feed_configured',
      stages: {
        s3: { status: 'skipped', reason: 'S3 not configured' },
        rss: { status: 'skipped', reason: 'RSS not configured' },
      },
    } satisfies PublishResult);

    const outcome = await createGenerateAndPublishExecutor(
      GenerateAndPublishInput.parse(input),
      { generate, publish },
    )(() => {});

    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'no_storage_or_feed_configured' },
      result: {
        success: false,
        publish: { errorCode: 'no_storage_or_feed_configured' },
      },
    });
  });

  it('safely retains generated audio when publishing rejects unexpectedly', async () => {
    const secret = 'provider credentials and backend details';
    const generate = vi.fn().mockResolvedValue({
      success: true,
      outputPath: '/output/episode.mp3',
      durationSeconds: 42,
    });
    const publish = vi.fn().mockRejectedValue(new Error(secret));

    const outcome = await createGenerateAndPublishExecutor(
      GenerateAndPublishInput.parse(input),
      { generate, publish },
      'https://public.example.com',
    )(() => {});

    expect(generate).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      status: 'failed',
      error: { code: 'job_execution_failed', message: 'Job execution failed' },
      result: {
        success: false,
        generation: { success: true, outputPath: '/output/episode.mp3', durationSeconds: 42 },
        downloadUrl: 'https://public.example.com/output/episode.mp3',
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});

describe('publish stage callback', () => {
  it('reports probe, upload, and feed-update boundaries for a full publish', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-publish-stage-'));
    const filename = 'stage-callback.mp3';
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, 'not a real mp3');
    const stages: string[] = [];
    const storage: StorageBackend = {
      upload: vi.fn().mockResolvedValue({
        url: 'https://cdn.example.com/episode.mp3',
        lengthBytes: 14,
        mimeType: 'audio/mpeg',
      }),
    };
    const feed: FeedBackend = {
      addEpisode: vi.fn().mockResolvedValue({
        feedUrl: 'https://cdn.example.com/podcast.xml',
        episodeGuid: 'episode-1',
      }),
    };
    const publish = createPublishHandler({
      storage,
      feed: {
        feed,
        feedUrl: 'https://cdn.example.com/podcast.xml',
        publicUrl: 'https://cdn.example.com',
        podcast: {
          title: 'Test', link: 'https://example.com', description: 'Test', author: 'Test',
          language: 'en-us', categories: [],
        },
      },
      s3: { bucket: 'podcasts', publicUrl: 'https://cdn.example.com' },
      outputDir,
    });

    try {
      await publish({
        outputFilename: filename,
        episodeTitle: 'Episode one',
        episodeDescription: 'A description',
      }, (stage) => stages.push(stage));
      expect(stages).toEqual(['probing', 'uploading', 'updating_feed']);
    } finally {
      fs.rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it('reports only probing and uploading for an S3-only publish', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-publish-s3-'));
    const filename = 's3-only.mp3';
    fs.writeFileSync(path.join(outputDir, filename), 'not a real mp3');
    const stages: string[] = [];
    const storage: StorageBackend = {
      upload: vi.fn().mockResolvedValue({
        url: 'https://cdn.example.com/episode.mp3',
        lengthBytes: 14,
        mimeType: 'audio/mpeg',
      }),
    };
    const publish = createPublishHandler({
      storage,
      s3: { bucket: 'podcasts', publicUrl: 'https://cdn.example.com' },
      outputDir,
    });

    try {
      await publish({
        outputFilename: filename,
        episodeTitle: 'Episode one',
        episodeDescription: 'A description',
      }, (stage) => stages.push(stage));
      expect(stages).toEqual(['probing', 'uploading']);
    } finally {
      fs.rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it('reports only probing and feed update for an RSS-only publish', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-publish-rss-'));
    const filename = 'rss-only.mp3';
    fs.writeFileSync(path.join(outputDir, filename), 'not a real mp3');
    const stages: string[] = [];
    const feed: FeedBackend = {
      addEpisode: vi.fn().mockResolvedValue({
        feedUrl: 'https://cdn.example.com/podcast.xml',
        episodeGuid: 'episode-1',
      }),
    };
    const publish = createPublishHandler({
      storage: {
        upload: vi.fn(),
      },
      feed: {
        feed,
        feedUrl: 'https://cdn.example.com/podcast.xml',
        publicUrl: 'https://cdn.example.com',
        podcast: {
          title: 'Test', link: 'https://example.com', description: 'Test', author: 'Test',
          language: 'en-us', categories: [],
        },
      },
      outputDir,
      publishPublicUrl: 'https://cdn.example.com',
    });

    try {
      await publish({
        outputFilename: filename,
        episodeTitle: 'Episode one',
        episodeDescription: 'A description',
      }, (stage) => stages.push(stage));
      expect(stages).toEqual(['probing', 'updating_feed']);
    } finally {
      fs.rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it('reports probing before returning the no-destination result', async () => {
    const stages: string[] = [];
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-publish-none-'));
    const publish = createPublishHandler({
      storage: { upload: vi.fn() },
      outputDir,
    });

    try {
      const result = await publish({
        outputFilename: 'episode.mp3',
        episodeTitle: 'Episode one',
        episodeDescription: 'A description',
      }, (stage) => stages.push(stage));

      expect(stages).toEqual(['probing']);
      expect(result).toMatchObject({ success: false, errorCode: 'no_storage_or_feed_configured' });
    } finally {
      fs.rmSync(outputDir, { force: true, recursive: true });
    }
  });
});
