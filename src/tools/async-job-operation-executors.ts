import type { Executor, JobExecutionResult, JsonObject, StageReporter } from '../jobs/job-types.js';
import type { GeneratePodcastInputType, GeneratePodcastOutput } from './generate-podcast.js';
import type { PublishPodcastInput } from './publish-podcast.js';
import type { PublishResult } from '../feed/feed-types.js';
import { publishResultToInertJson } from './generate-and-publish.js';

export interface GenerateExecutorDependencies {
  generate(input: GeneratePodcastInputType): Promise<GeneratePodcastOutput>;
}

export function createGenerateExecutor(
  input: GeneratePodcastInputType,
  dependencies: GenerateExecutorDependencies,
  publicUrl: string
): Executor {
  return async (report: StageReporter): Promise<JobExecutionResult> => {
    report('generating');
    const generationResult = await dependencies.generate(input);
    return {
      status: 'succeeded',
      result: {
        ...generationResult,
        downloadUrl: `${publicUrl}/output/${input.outputFilename}`,
      },
    };
  };
}

export interface PublishExecutorDependencies {
  publish(
    input: PublishPodcastInput,
    stageCallback?: (stage: 'probing' | 'uploading' | 'updating_feed') => void
  ): Promise<PublishResult>;
}

export function createPublishExecutor(
  input: PublishPodcastInput,
  dependencies: PublishExecutorDependencies
): Executor {
  return async (report: StageReporter): Promise<JobExecutionResult> => {
    report('probing');
    const publishResult = await dependencies.publish(input, report);
    const publishJson: JsonObject = publishResultToInertJson(publishResult);

    if (publishResult.success) return { status: 'succeeded', result: publishJson };
    return {
      status: 'failed',
      error: {
        code: publishResult.errorCode ?? 'publish_failed',
        message: 'Publishing failed',
      },
      result: publishJson,
    };
  };
}
