import { mkdir, unlink } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { GeminiTTSClient, formatScript } from '../tts/gemini-client.js';
import { Assembler } from '../audio/assembler.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('generate-podcast');

// Input schema
export const GeneratePodcastInput = z.object({
  type: z.enum(['single', 'dual']).describe('Single host monologue or dual host dialogue'),
  hosts: z
    .array(
      z.object({
        name: z.string().min(1).describe('Speaker name, e.g. "Alex"'),
        voice: z.string().min(1).describe('Gemini prebuilt voice name, e.g. "Charon", "Puck"'),
      })
    )
    .min(1)
    .max(2)
    .describe('Host configurations. Single host: 1 entry. Dual host: exactly 2 entries.'),
  segments: z
    .array(
      z.object({
        speaker: z
          .string()
          .optional()
          .describe('Speaker name (must match a host name). Optional for single-host.'),
        text: z.string().min(1).describe('The text to speak'),
      })
    )
    .min(1)
    .describe('Script segments'),
  outputFilename: z
    .string()
    .min(1)
    .describe('Output filename, e.g. "episode-2026-04-02.mp3"'),
  introMusicUrl: z
    .string()
    .url()
    .optional()
    .describe('Optional HTTPS URL to intro music file (mp3, wav, etc.)'),
  outroMusicUrl: z
    .string()
    .url()
    .optional()
    .describe('Optional HTTPS URL to outro music file (mp3, wav, etc.)'),
  fadeInDuration: z
    .number()
    .min(0)
    .max(30)
    .default(2)
    .describe('Fade-in duration in seconds (default: 2)'),
  fadeOutDuration: z
    .number()
    .min(0)
    .max(30)
    .default(3)
    .describe('Fade-out duration in seconds (default: 3)'),
  targetLufs: z
    .number()
    .min(-40)
    .max(-5)
    .default(-16)
    .describe('Target loudness in LUFS for EBU R128 normalization (default: -16)'),
});

export type GeneratePodcastInputType = z.infer<typeof GeneratePodcastInput>;

export interface GeneratePodcastOutput {
  success: boolean;
  outputPath: string;
  durationSeconds: number;
}

export async function generatePodcast(
  input: GeneratePodcastInputType,
  config: { googleApiKey: string; outputDir: string; tempDir: string }
): Promise<GeneratePodcastOutput> {
  const { googleApiKey, outputDir, tempDir } = config;

  // Validate dual-host requirements
  if (input.type === 'dual') {
    if (input.hosts.length !== 2) {
      throw new Error('Dual-host mode requires exactly 2 hosts');
    }
    const hostNames = new Set(input.hosts.map((h) => h.name));
    for (const segment of input.segments) {
      if (!segment.speaker) {
        throw new Error('Dual-host mode requires all segments to have a speaker field');
      }
      if (!hostNames.has(segment.speaker)) {
        throw new Error(
          `Segment speaker "${segment.speaker}" does not match any configured host (${[...hostNames].join(', ')})`
        );
      }
    }
  }

  await mkdir(outputDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ttsOutputPath = path.join(tempDir, `tts-${ts}.mp3`);
  const outputPath = path.join(outputDir, input.outputFilename);

  const totalWords = input.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0);

  log.info(
    {
      type: input.type,
      segments: input.segments.length,
      words: totalWords,
      hosts: input.hosts.map((h) => `${h.name} (${h.voice})`),
      introMusic: !!input.introMusicUrl,
      outroMusic: !!input.outroMusicUrl,
      output: input.outputFilename,
    },
    'Starting podcast generation'
  );

  const gemini = new GeminiTTSClient(googleApiKey, tempDir);
  const scriptText = formatScript(input.segments, input.type);

  log.info(
    { model: 'gemini-2.5-flash-preview-tts', type: input.type, chars: scriptText.length },
    'Sending script to Gemini TTS — this can take a while for long scripts'
  );
  const ttsStart = Date.now();

  try {
    // Generate TTS audio
    if (input.type === 'dual') {
      await gemini.generateDualHost(
        scriptText,
        input.hosts as [typeof input.hosts[0], typeof input.hosts[0]],
        ttsOutputPath,
        tempDir
      );
    } else {
      await gemini.generateSingleHost(scriptText, input.hosts[0], ttsOutputPath, tempDir);
    }

    log.info({ durationMs: Date.now() - ttsStart }, 'Gemini TTS complete');

    log.info('Assembling episode (normalize + music + concat + final normalize)');
    const assembleStart = Date.now();

    // Assemble with optional music + normalization
    const assembler = new Assembler(tempDir);
    const result = await assembler.assemble({
      ttsAudioPath: ttsOutputPath,
      outputPath,
      introMusicUrl: input.introMusicUrl,
      outroMusicUrl: input.outroMusicUrl,
      fadeInDuration: input.fadeInDuration,
      fadeOutDuration: input.fadeOutDuration,
      targetLufs: input.targetLufs,
    });

    log.info(
      {
        outputPath: result.outputPath,
        durationSeconds: result.durationSeconds.toFixed(1),
        assembleMs: Date.now() - assembleStart,
      },
      'Podcast generation complete'
    );

    return {
      success: true,
      outputPath: result.outputPath,
      durationSeconds: result.durationSeconds,
    };
  } finally {
    await unlink(ttsOutputPath).catch(() => {});
  }
}
