import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFile, readFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import { FFmpeg } from '../audio/ffmpeg.js';
import { Normalizer, WORKING_LEVEL_LUFS } from '../audio/normalizer.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('gemini-tts');

export interface HostConfig {
  name: string;
  voice: string;
}

/**
 * Gemini 2.5 TTS hard-stops audio generation at ~5:27 per call and the audio
 * quality progressively degrades as the model approaches that limit (audible
 * pumping, clipping, "underwater" artifacts in the final minute or two).
 *
 * To stay safely inside the high-quality envelope we chunk the script so each
 * single API call produces roughly 2.5-3 minutes of speech. At ~165 WPM that
 * translates to ~450 spoken words per chunk — about half of the hard cap, so
 * there is headroom when the model speaks faster than the estimate.
 */
const CHUNK_TARGET_WORDS = 450;

/**
 * Resolve the per-call chunk budget. TTS_CHUNK_TARGET_WORDS overrides the
 * default; out-of-range or non-numeric values fall back to the default.
 * Range guard: below ~100 words the per-call level variance between chunks
 * becomes audible; above ~800 words a call risks the quality envelope.
 */
export function resolveChunkTargetWords(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.TTS_CHUNK_TARGET_WORDS;
  if (!raw) return CHUNK_TARGET_WORDS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 50 || parsed > 800) {
    log.warn({ raw }, 'Invalid TTS_CHUNK_TARGET_WORDS — using default ' + CHUNK_TARGET_WORDS);
    return CHUNK_TARGET_WORDS;
  }
  return parsed;
}

export class GeminiTTSClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: string;
  private readonly ffmpeg: FFmpeg;
  private readonly normalizer: Normalizer;

  constructor(apiKey: string, tempDir: string, model: string = 'gemini-2.5-flash-preview-tts') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
    this.ffmpeg = new FFmpeg();
    this.normalizer = new Normalizer(this.ffmpeg, tempDir);
  }

  /**
   * Generate audio for a dual-host dialogue script.
   * Script should be formatted as "Speaker: text\nSpeaker2: text\n..."
   */
  async generateDualHost(
    dialogueText: string,
    hosts: [HostConfig, HostConfig],
    outputPcmPath: string,
    tempDir: string
  ): Promise<void> {
    await mkdir(tempDir, { recursive: true });

    log.info(
      { host1: `${hosts[0].name}/${hosts[0].voice}`, host2: `${hosts[1].name}/${hosts[1].voice}` },
      'Calling Gemini TTS (dual-host)'
    );

    const speakerVoiceConfigs = hosts.map((host) => ({
      speaker: host.name,
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: host.voice },
      },
    }));

    const modelInstance = this.genAI.getGenerativeModel({
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs,
          },
        },
      } as unknown as Parameters<typeof this.genAI.getGenerativeModel>[0]['generationConfig'],
    });

    const chunkTargetWords = resolveChunkTargetWords();
    const chunks = chunkDialogue(dialogueText, chunkTargetWords);
    const pcm = await this.generatePcmInChunks(modelInstance, chunks, tempDir);
    await writeFile(outputPcmPath, pcm);
    log.info({ outputPcmPath }, 'TTS PCM saved');
  }

  /**
   * Generate audio for a single-host monologue script.
   */
  async generateSingleHost(
    text: string,
    host: HostConfig,
    outputPcmPath: string,
    tempDir: string
  ): Promise<void> {
    await mkdir(tempDir, { recursive: true });

    log.info({ host: `${host.name}/${host.voice}` }, 'Calling Gemini TTS (single-host)');

    const modelInstance = this.genAI.getGenerativeModel({
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: host.voice },
          },
        },
      } as unknown as Parameters<typeof this.genAI.getGenerativeModel>[0]['generationConfig'],
    });

    const chunkTargetWords = resolveChunkTargetWords();
    const chunks = chunkMonologue(text, chunkTargetWords);
    const pcm = await this.generatePcmInChunks(modelInstance, chunks, tempDir);
    await writeFile(outputPcmPath, pcm);
    log.info({ outputPcmPath }, 'TTS PCM saved');
  }

  /**
   * Call Gemini once per chunk. Each chunk is level-matched in isolation
   * (static gain to the working level) so per-call level variance between
   * chunks is masked at the boundaries, then concatenated as raw PCM.
   */
  private async generatePcmInChunks(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelInstance: any,
    chunks: string[],
    tempDir: string
  ): Promise<Buffer> {
    if (chunks.length === 0) {
      // The zod schema allows whitespace-only text via z.string().min(1), which
      // chunk{Dialogue,Monologue} collapse to an empty array. Fail loudly here
      // rather than letting an empty PCM buffer reach ffmpeg.
      throw new Error('Cannot synthesize empty script \u2014 no spoken content provided');
    }

    log.info({ chunks: chunks.length }, 'Generating TTS in chunks (each call stays inside Gemini\u2019s ~5min/quality envelope)');

    const pcmParts: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const start = Date.now();
      const pcm = await this.synthesizeChunkWithRetry(modelInstance, chunks[i]);
      const leveled = await this.matchChunkToWorkingLevel(pcm, tempDir);
      log.info(
        {
          chunk: i + 1,
          of: chunks.length,
          words: chunks[i].split(/\s+/).length,
          pcmBytes: leveled.length,
          durationMs: Date.now() - start,
        },
        'Chunk synthesized'
      );
      pcmParts.push(leveled);
    }

    return Buffer.concat(pcmParts);
  }

  /**
   * One retry per chunk call. A longer chunk failing otherwise fails the whole
   * episode; single transient API errors (429/5xx, truncated responses) are
   * common enough that an immediate retry is cheap insurance.
   */
  private async synthesizeChunkWithRetry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelInstance: any,
    chunk: string
  ): Promise<Buffer> {
    try {
      return await this.synthesizeChunk(modelInstance, chunk);
    } catch (firstErr) {
      log.warn({ err: firstErr }, 'Chunk TTS call failed — retrying once');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.synthesizeChunk(modelInstance, chunk);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async synthesizeChunk(modelInstance: any, chunk: string): Promise<Buffer> {
    const result = await modelInstance.generateContent(chunk);
    return this.extractAllPcmAudio(result);
  }

  /**
   * Extract every PCM audio buffer from a Gemini response. A single response
   * may carry the audio across multiple `inlineData` parts; concatenating them
   * is required to avoid silently dropping the tail of the audio.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractAllPcmAudio(result: any): Buffer {
    const parts = result.response?.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error('Gemini TTS returned no content parts');
    }

    const buffers: Buffer[] = [];
    for (const part of parts) {
      const data = part?.inlineData?.data;
      if (typeof data === 'string' && data.length > 0) {
        buffers.push(Buffer.from(data, 'base64'));
      }
    }

    if (buffers.length === 0) {
      throw new Error('Gemini TTS returned no audio data in response parts');
    }

    return Buffer.concat(buffers);
  }

  /**
   * Level-match one chunk to the pipeline working level. Measurement happens
   * on the raw s16le PCM Gemini returns; the gain is applied statically so
   * the chunk's dynamics are untouched. Output is f32le so later gain stages
   * cannot clip.
   */
  private async matchChunkToWorkingLevel(pcm: Buffer, tempDir: string): Promise<Buffer> {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const rawPath = path.join(tempDir, `tts-chunk-${ts}.pcm`);
    const leveledPath = path.join(tempDir, `tts-chunk-level-${ts}.pcm`);

    try {
      await writeFile(rawPath, pcm);
      const gainDb = await this.normalizer.matchLoudness(
        rawPath,
        leveledPath,
        WORKING_LEVEL_LUFS,
        's16le'
      );
      log.debug({ gainDb }, 'Chunk matched to working level');
      return await readFile(leveledPath);
    } finally {
      await unlink(rawPath).catch(() => {});
      await unlink(leveledPath).catch(() => {});
    }
  }
}

/**
 * Format segments into the dialogue string Gemini expects.
 * For dual host: "Alex: text\nSam: text\n..."
 * For single host: plain text joined with paragraph breaks
 */
export function formatScript(
  segments: Array<{ speaker?: string; text: string }>,
  type: 'single' | 'dual'
): string {
  if (type === 'single') {
    return segments.map((s) => s.text).join('\n\n');
  }
  return segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');
}

/**
 * Split a dual-host dialogue (one "Speaker: text" per line) into chunks that
 * each contain at most CHUNK_TARGET_WORDS words. Splits only on speaker-turn
 * boundaries so prosody is preserved within a single utterance.
 */
export function chunkDialogue(
  dialogueText: string,
  targetWords: number = CHUNK_TARGET_WORDS
): string[] {
  const lines = dialogueText.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  return groupByWordBudget(lines, '\n', targetWords);
}

/**
 * Split a single-host monologue (paragraphs separated by blank lines) into
 * chunks that each contain at most CHUNK_TARGET_WORDS words. Paragraphs that
 * are themselves over budget are subdivided at sentence boundaries so a
 * caller passing one giant segment still gets safe-sized chunks.
 *
 * Sentences from an over-budget paragraph are emitted as their own chunks
 * (joined by spaces) rather than being folded back into the paragraph-level
 * grouper — otherwise they would be rejoined across chunks with "\n\n", which
 * introduces paragraph-sized pauses that change pacing/prosody mid-paragraph.
 */
export function chunkMonologue(
  text: string,
  targetWords: number = CHUNK_TARGET_WORDS
): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  if (paragraphs.length === 0) return [];

  const result: string[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  const flush = () => {
    if (buffer.length > 0) {
      result.push(buffer.join('\n\n'));
      buffer = [];
      bufferWords = 0;
    }
  };

  for (const para of paragraphs) {
    const wordCount = para.trim().split(/\s+/).length;

    if (wordCount > targetWords) {
      // Oversized paragraph: emit any buffered paragraphs, then emit this
      // paragraph's sentence-split sub-chunks directly so they keep intra-
      // paragraph spacing.
      flush();
      for (const sub of splitParagraphBySentence(para, targetWords)) {
        result.push(sub);
      }
      continue;
    }

    if (bufferWords + wordCount > targetWords && buffer.length > 0) {
      flush();
    }
    buffer.push(para);
    bufferWords += wordCount;
  }

  flush();
  return result;
}

function splitParagraphBySentence(paragraph: string, targetWords: number): string[] {
  // Keep the terminating punctuation attached to each sentence.
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g);
  if (!sentences || sentences.length <= 1) {
    // No sentence boundaries to split on — return as-is and let it be its own
    // (over-budget) chunk. Better to send a long line than to slice mid-word.
    return [paragraph];
  }
  return groupByWordBudget(
    sentences.map((s) => s.trim()).filter((s) => s.length > 0),
    ' ',
    targetWords
  );
}

function groupByWordBudget(units: string[], joiner: string, targetWords: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const unit of units) {
    const words = unit.trim().split(/\s+/).length;
    // If this single unit alone exceeds the budget, emit it as its own chunk
    // (rather than splitting mid-sentence which would break prosody).
    if (words >= targetWords) {
      if (current.length > 0) {
        chunks.push(current.join(joiner));
        current = [];
        currentWords = 0;
      }
      chunks.push(unit);
      continue;
    }

    if (currentWords + words > targetWords && current.length > 0) {
      chunks.push(current.join(joiner));
      current = [];
      currentWords = 0;
    }
    current.push(unit);
    currentWords += words;
  }

  if (current.length > 0) {
    chunks.push(current.join(joiner));
  }
  return chunks;
}
