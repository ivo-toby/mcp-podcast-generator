import { mkdir, unlink } from 'fs/promises';
import path from 'path';
import { FFmpeg } from './ffmpeg.js';
import { Normalizer } from './normalizer.js';
import { downloadFile } from '../utils/download.js';

export interface AssemblyOptions {
  ttsAudioPath: string;
  outputPath: string;
  introMusicUrl?: string;
  outroMusicUrl?: string;
  fadeInDuration: number;
  fadeOutDuration: number;
  targetLufs: number;
}

export interface AssemblyResult {
  outputPath: string;
  durationSeconds: number;
}

export class Assembler {
  private readonly ffmpeg: FFmpeg;
  private readonly normalizer: Normalizer;

  constructor(private readonly tempDir: string) {
    this.ffmpeg = new FFmpeg(tempDir);
    this.normalizer = new Normalizer(this.ffmpeg, tempDir);
  }

  async assemble(options: AssemblyOptions): Promise<AssemblyResult> {
    const {
      ttsAudioPath,
      outputPath,
      introMusicUrl,
      outroMusicUrl,
      fadeInDuration,
      fadeOutDuration,
      targetLufs,
    } = options;

    await mkdir(this.tempDir, { recursive: true });

    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempFiles: string[] = [];
    const audioParts: string[] = [];

    try {
      // 1. Normalize the TTS audio
      const normalizedTts = path.join(this.tempDir, `tts-norm-${ts}.mp3`);
      tempFiles.push(normalizedTts);
      await this.normalizer.normalizeFile(ttsAudioPath, normalizedTts, targetLufs);

      // 2. Download and prepare intro music (if provided)
      if (introMusicUrl) {
        const introRaw = await downloadFile(introMusicUrl, this.tempDir, `intro-raw-${ts}`);
        tempFiles.push(introRaw);

        const introFaded = path.join(this.tempDir, `intro-faded-${ts}.mp3`);
        tempFiles.push(introFaded);
        await this.ffmpeg.addFade(introRaw, introFaded, fadeInDuration, 0);
        audioParts.push(introFaded);
      }

      // 3. Add TTS audio
      audioParts.push(normalizedTts);

      // 4. Download and prepare outro music (if provided)
      if (outroMusicUrl) {
        const outroRaw = await downloadFile(outroMusicUrl, this.tempDir, `outro-raw-${ts}`);
        tempFiles.push(outroRaw);

        const outroFaded = path.join(this.tempDir, `outro-faded-${ts}.mp3`);
        tempFiles.push(outroFaded);
        await this.ffmpeg.addFade(outroRaw, outroFaded, 0, fadeOutDuration);
        audioParts.push(outroFaded);
      }

      // 5. Concatenate all parts
      const rawConcat = path.join(this.tempDir, `concat-raw-${ts}.mp3`);
      tempFiles.push(rawConcat);
      await this.ffmpeg.concatenate(audioParts, rawConcat);

      // 6. Final normalization pass on complete episode
      await this.normalizer.normalizeFile(rawConcat, outputPath, targetLufs);

      // 7. Get final duration
      const durationSeconds = await this.ffmpeg.getDurationSeconds(outputPath);

      return { outputPath, durationSeconds };
    } finally {
      // Clean up all temp files
      await Promise.all(
        tempFiles.map((f) => unlink(f).catch(() => {}))
      );
    }
  }
}
