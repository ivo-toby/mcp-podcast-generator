import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import path from 'path';
import { FFmpeg } from '../audio/ffmpeg.js';
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
 * single API call produces roughly 60-90 seconds of speech. At ~165 WPM that
 * translates to ~250 spoken words per chunk.
 */
const CHUNK_TARGET_WORDS = 250;

export class GeminiTTSClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: string;
  private readonly ffmpeg: FFmpeg;

  constructor(apiKey: string, tempDir: string, model: string = 'gemini-2.5-flash-preview-tts') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
    this.ffmpeg = new FFmpeg(tempDir);
  }

  /**
   * Generate audio for a dual-host dialogue script.
   * Script should be formatted as "Speaker: text\nSpeaker2: text\n..."
   */
  async generateDualHost(
    dialogueText: string,
    hosts: [HostConfig, HostConfig],
    outputMp3Path: string,
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

    const chunks = chunkDialogue(dialogueText);
    const pcm = await this.generatePcmInChunks(modelInstance, chunks);
    await this.savePcmAsMp3(pcm, outputMp3Path, tempDir);
    log.info({ outputMp3Path }, 'TTS audio saved');
  }

  /**
   * Generate audio for a single-host monologue script.
   */
  async generateSingleHost(
    text: string,
    host: HostConfig,
    outputMp3Path: string,
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

    const chunks = chunkMonologue(text);
    const pcm = await this.generatePcmInChunks(modelInstance, chunks);
    await this.savePcmAsMp3(pcm, outputMp3Path, tempDir);
    log.info({ outputMp3Path }, 'TTS audio saved');
  }

  /**
   * Call Gemini once per chunk and concatenate the raw PCM responses.
   * Concatenating at the PCM level (rather than re-encoding each chunk to MP3
   * and stitching) avoids generational lossy-codec damage and frame-boundary
   * clicks between chunks.
   */
  private async generatePcmInChunks(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelInstance: any,
    chunks: string[]
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
      const result = await modelInstance.generateContent(chunks[i]);
      const pcm = this.extractAllPcmAudio(result);
      log.info(
        {
          chunk: i + 1,
          of: chunks.length,
          words: chunks[i].split(/\s+/).length,
          pcmBytes: pcm.length,
          durationMs: Date.now() - start,
        },
        'Chunk synthesized'
      );
      pcmParts.push(pcm);
    }

    return Buffer.concat(pcmParts);
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

  private async savePcmAsMp3(
    pcmBuffer: Buffer,
    outputMp3Path: string,
    tempDir: string
  ): Promise<void> {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pcmPath = path.join(tempDir, `gemini-raw-${ts}.pcm`);

    try {
      log.debug({ pcmBytes: pcmBuffer.length, pcmPath }, 'Writing combined PCM to disk');
      await writeFile(pcmPath, pcmBuffer);

      log.debug({ pcmPath, outputMp3Path }, 'Converting PCM \u2192 MP3 via FFmpeg');
      await this.ffmpeg.convertPcmToMp3(pcmPath, outputMp3Path);
      log.debug('PCM \u2192 MP3 conversion done');
    } finally {
      const { unlink } = await import('fs/promises');
      await unlink(pcmPath).catch(() => {});
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
