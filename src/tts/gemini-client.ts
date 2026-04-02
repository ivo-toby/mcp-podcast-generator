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

    const start = Date.now();
    const result = await modelInstance.generateContent(dialogueText);
    log.info({ durationMs: Date.now() - start }, 'Gemini API responded');

    const audioData = this.extractAudioData(result);
    log.debug({ bytes: Math.round(audioData.length * 0.75) }, 'Received PCM audio data, converting to MP3');

    await this.saveAudioToMp3(audioData, outputMp3Path, tempDir);
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

    const start = Date.now();
    const result = await modelInstance.generateContent(text);
    log.info({ durationMs: Date.now() - start }, 'Gemini API responded');

    const audioData = this.extractAudioData(result);
    log.debug({ bytes: Math.round(audioData.length * 0.75) }, 'Received PCM audio data, converting to MP3');

    await this.saveAudioToMp3(audioData, outputMp3Path, tempDir);
    log.info({ outputMp3Path }, 'TTS audio saved');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractAudioData(result: any): string {
    const parts = result.response?.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error('Gemini TTS returned no content parts');
    }

    for (const part of parts) {
      if (part?.inlineData?.data) {
        return part.inlineData.data as string;
      }
    }

    throw new Error('Gemini TTS returned no audio data in response parts');
  }

  private async saveAudioToMp3(
    base64AudioData: string,
    outputMp3Path: string,
    tempDir: string
  ): Promise<void> {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pcmPath = path.join(tempDir, `gemini-raw-${ts}.pcm`);

    try {
      // Decode base64 PCM data and write to temp file
      const pcmBuffer = Buffer.from(base64AudioData, 'base64');
      log.debug({ pcmBytes: pcmBuffer.length, pcmPath }, 'Writing PCM to disk');
      await writeFile(pcmPath, pcmBuffer);

      // Convert PCM (24kHz, 16-bit mono) to MP3
      log.debug({ pcmPath, outputMp3Path }, 'Converting PCM → MP3 via FFmpeg');
      await this.ffmpeg.convertPcmToMp3(pcmPath, outputMp3Path);
      log.debug('PCM → MP3 conversion done');
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
