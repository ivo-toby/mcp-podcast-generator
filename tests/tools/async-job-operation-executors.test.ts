import { describe, expect, it, vi } from 'vitest';
import type { PublishResult } from '../../src/feed/feed-types.js';
import { GeneratePodcastInput } from '../../src/tools/generate-podcast.js';
import { PublishPodcastInput } from '../../src/tools/publish-podcast.js';
import { createGenerateExecutor, createPublishExecutor } from '../../src/tools/async-job-operation-executors.js';

const generationInput = GeneratePodcastInput.parse({
  type: 'single',
  hosts: [{ name: 'Alex', voice: 'Charon' }],
  segments: [{ text: 'Hello world.' }],
  outputFilename: 'episode.mp3',
});

const publishInput = PublishPodcastInput.parse({
  outputFilename: 'episode.mp3',
  episodeTitle: 'Episode one',
  episodeDescription: 'A description',
  episodeNumber: 7,
});

const generationOutput = { success: true, outputPath: '/output/episode.mp3', durationSeconds: 42 };

describe('generate_podcast executor', () => {
  it('reports generating, invokes generation exactly once, and succeeds with the output plus downloadUrl', async () => {
    const generate = vi.fn().mockResolvedValue(generationOutput);
    const stages: string[] = [];
    const outcome = await createGenerateExecutor(generationInput, { generate }, 'https://cdn.example.com')((stage) => stages.push(stage));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(generationInput);
    expect(stages).toEqual(['generating']);
    expect(outcome).toEqual({ status: 'succeeded', result: { ...generationOutput, downloadUrl: 'https://cdn.example.com/output/episode.mp3' } });
  });

  it('lets a generation rejection escape after reporting generating', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('generation failed'));
    const stages: string[] = [];
    await expect(createGenerateExecutor(generationInput, { generate }, 'https://cdn.example.com')((stage) => stages.push(stage))).rejects.toThrow('generation failed');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(['generating']);
  });
});

describe('publish_podcast executor', () => {
  it('reports probing, forwards stage reporting, invokes publish once, and maps success', async () => {
    const publish = vi.fn().mockImplementation(async (_input: unknown, stageCallback?: (stage: 'probing' | 'uploading' | 'updating_feed') => void): Promise<PublishResult> => {
      stageCallback?.('uploading');
      stageCallback?.('updating_feed');
      return { success: true, fileSizeBytes: 1234, durationSeconds: 42, stages: { s3: { status: 'succeeded', s3Url: 'https://cdn.example.com/episode.mp3' }, rss: { status: 'skipped', reason: 'not configured' } } };
    });
    const stages: string[] = [];
    const outcome = await createPublishExecutor(publishInput, { publish })((stage) => stages.push(stage));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(publishInput, expect.any(Function));
    expect(stages).toEqual(['probing', 'uploading', 'updating_feed']);
    expect(outcome).toMatchObject({ status: 'succeeded', result: { success: true, fileSizeBytes: 1234, durationSeconds: 42 } });
  });

  it('awaits a deferred publish result before settling', async () => {
    let resolvePublish!: (result: PublishResult) => void;
    const publish = vi.fn().mockReturnValue(new Promise<PublishResult>((resolve) => { resolvePublish = resolve; }));
    const pending = createPublishExecutor(publishInput, { publish })(() => {});
    expect(publish).toHaveBeenCalledTimes(1);
    resolvePublish({ success: true, stages: { s3: { status: 'succeeded', s3Url: 'https://cdn.example.com/episode.mp3' }, rss: { status: 'skipped', reason: 'not configured' } } });
    await expect(pending).resolves.toMatchObject({ status: 'succeeded', result: { success: true } });
  });

  it('fails with the publish errorCode and retains stage and probe details', async () => {
    const publish = vi.fn().mockResolvedValue({ success: false, errorCode: 'rss_update_failed', fileSizeBytes: 1234, probeFFprobeFailed: true, stages: { s3: { status: 'succeeded', s3Url: 'https://cdn.example.com/episode.mp3' }, rss: { status: 'failed', errorCode: 'rss_update_failed', errorMessage: 'network' } } } satisfies PublishResult);
    const outcome = await createPublishExecutor(publishInput, { publish })(() => {});
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'rss_update_failed', message: 'Publishing failed' }, result: { success: false, errorCode: 'rss_update_failed', fileSizeBytes: 1234, probeFFprobeFailed: true } });
  });

  it('falls back to publish_failed when an unsuccessful result carries no errorCode', async () => {
    const publish = vi.fn().mockResolvedValue({ success: false, probeStatFailed: true, stages: { s3: { status: 'skipped', reason: 'not configured' }, rss: { status: 'skipped', reason: 'not configured' } } } satisfies PublishResult);
    const outcome = await createPublishExecutor(publishInput, { publish })(() => {});
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'publish_failed', message: 'Publishing failed' }, result: { success: false, probeStatFailed: true } });
  });
});
