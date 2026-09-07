import { z } from 'zod';
import {
  GeneratePodcastInput,
  type GeneratePodcastInputType,
  type GeneratePodcastOutput,
} from './generate-podcast.js';
import { PublishPodcastInput } from './publish-podcast.js';
import type { Executor, StageReporter, JobExecutionResult, JsonObject } from '../jobs/job-types.js';
import type { PublishResult } from '../feed/feed-types.js';

/** Merged schema: generation owns `outputFilename` (with its min(1) constraint). */
export const GenerateAndPublishInput = z.object({
  ...GeneratePodcastInput.shape,
  ...z.object(PublishPodcastInput.shape).omit({ outputFilename: true }).shape,
});

export type GenerateAndPublishInputType = z.infer<typeof GenerateAndPublishInput>;

/** Terminal result exposed by a combined generation/publish job. */
export interface GenerateAndPublishResult {
  success: boolean;
  generation?: GeneratePodcastOutput;
  publish?: PublishResult;
  downloadUrl?: string;
}

/** Dependency contract injected at executor construction time. */
export interface GenerateAndPublishDependencies {
  generate(input: GeneratePodcastInputType): Promise<GeneratePodcastOutput>;
  publish(
    input: {
      outputFilename: string;
      episodeTitle: string;
      episodeDescription: string;
      episodeNumber?: number;
      episodeSeason?: number;
      episodeGuid?: string;
      episodePublishedAt?: string;
    },
    stageCallback?: (stage: 'probing' | 'uploading' | 'updating_feed') => void
  ): Promise<PublishResult>;
}

/**
 * Convert a `PublishResult` into the inert `JsonObject` persisted in job status.
 * Preserves `success`, `stages`, and every optional probe or error field.
 */
export function publishResultToInertJson(publishResult: PublishResult): JsonObject {
  return {
    success: publishResult.success,
    stages: publishResult.stages,
    ...(publishResult.fileSizeBytes !== undefined && { fileSizeBytes: publishResult.fileSizeBytes }),
    ...(publishResult.durationSeconds !== undefined && { durationSeconds: publishResult.durationSeconds }),
    ...(publishResult.probeStatFailed !== undefined && { probeStatFailed: publishResult.probeStatFailed }),
    ...(publishResult.probeFFprobeFailed !== undefined && { probeFFprobeFailed: publishResult.probeFFprobeFailed }),
    ...(publishResult.errorCode !== undefined && { errorCode: publishResult.errorCode }),
  };
}

function generateResultToInertJson(generationResult: GeneratePodcastOutput): JsonObject {
  return {
    success: generationResult.success,
    outputPath: generationResult.outputPath,
    durationSeconds: generationResult.durationSeconds,
  };
}

/**
 * Create a bounded executor for the `generate_and_publish` operation.
 *
 * Reports `generating` before generation, `probing` before publishing.
 * Generation rejection propagates; the job manager owns safe conversion.
 */
export function createGenerateAndPublishExecutor(
  input: GenerateAndPublishInputType,
  dependencies: GenerateAndPublishDependencies,
  publicUrl?: string,
): Executor {
  return async (report: StageReporter): Promise<JobExecutionResult> => {
    report('generating');
    const generationResult = await dependencies.generate(input);
    const generationJson = generateResultToInertJson(generationResult);

    const downloadUrl =
      publicUrl === undefined
        ? undefined
        : `${publicUrl}/output/${input.outputFilename}`;

    report('probing');
    let publishResult: PublishResult;
    try {
      publishResult = await dependencies.publish(
        {
          outputFilename: input.outputFilename,
          episodeTitle: input.episodeTitle,
          episodeDescription: input.episodeDescription,
          ...(input.episodeNumber !== undefined && { episodeNumber: input.episodeNumber }),
          ...(input.episodeSeason !== undefined && { episodeSeason: input.episodeSeason }),
          ...(input.episodeGuid !== undefined && { episodeGuid: input.episodeGuid }),
          ...(input.episodePublishedAt !== undefined && { episodePublishedAt: input.episodePublishedAt }),
        },
        report
      );
    } catch {
      // Preserve generated audio while keeping provider/backend details out of
      // the public job result. The real publish handler normally returns a
      // PublishResult, but an injected or unexpected rejection must be safe too.
      return {
        status: 'failed',
        error: { code: 'job_execution_failed', message: 'Job execution failed' },
        result: {
          success: false,
          generation: generationJson,
          ...(downloadUrl !== undefined && { downloadUrl }),
        },
      };
    }

    const publishJson = publishResultToInertJson(publishResult);

    if (publishResult.success) {
      return {
        status: 'succeeded',
        result: {
          success: true,
          generation: generationJson,
          publish: publishJson,
          ...(downloadUrl !== undefined && { downloadUrl }),
        },
      };
    }

    return {
      status: 'failed',
      error: {
        code: publishResult.errorCode ?? 'publish_failed',
        message: 'Publishing failed',
      },
      result: {
        success: false,
        generation: generationJson,
        publish: publishJson,
        ...(downloadUrl !== undefined && { downloadUrl }),
      },
    };
  };
}
