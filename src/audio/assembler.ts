import { mkdir, unlink } from 'fs/promises';
import path from 'path';
import { FFmpeg } from './ffmpeg.js';
import { Normalizer } from './normalizer.js';
import { downloadFile } from '../utils/download.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('assembler');

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
      log.info({ targetLufs }, 'Step 1/6 — Normalizing TTS audio');
      const normalizedTts = path.join(this.tempDir, `tts-norm-${ts}.mp3`);
      tempFiles.push(normalizedTts);
      await this.normalizer.normalizeFile(ttsAudioPath, normalizedTts, targetLufs);
      log.debug('TTS normalization done');

      // 2. Download and prepare intro music (if provided)
      if (introMusicUrl) {
        log.info({ url: introMusicUrl }, 'Step 2/6 — Downloading intro music');
        const introRaw = await downloadFile(introMusicUrl, this.tempDir, `intro-raw-${ts}`);
        tempFiles.push(introRaw);

        log.debug({ fadeInDuration }, 'Applying fade-in to intro music');
        const introFaded = path.join(this.tempDir, `intro-faded-${ts}.mp3`);
        tempFiles.push(introFaded);
        await this.ffmpeg.addFade(introRaw, introFaded, fadeInDuration, 0);
        audioParts.push(introFaded);
        log.debug('Intro music ready');
      } else {
        log.debug('Step 2/6 — No intro music, skipping');
      }

      // 3. Add TTS audio
      log.debug('Step 3/6 — Adding TTS audio to mix');
      audioParts.push(normalizedTts);

      // 4. Download and prepare outro music (if provided)
      if (outroMusicUrl) {
        log.info({ url: outroMusicUrl }, 'Step 4/6 — Downloading outro music');
        const outroRaw = await downloadFile(outroMusicUrl, this.tempDir, `outro-raw-${ts}`);
        tempFiles.push(outroRaw);

        log.debug({ fadeOutDuration }, 'Applying fade-out to outro music');
        const outroFaded = path.join(this.tempDir, `outro-faded-${ts}.mp3`);
        tempFiles.push(outroFaded);
        await this.ffmpeg.addFade(outroRaw, outroFaded, 0, fadeOutDuration);
        audioParts.push(outroFaded);
        log.debug('Outro music ready');
      } else {
        log.debug('Step 4/6 — No outro music, skipping');
      }

      // 5. Concatenate all parts
      log.info({ parts: audioParts.length }, 'Step 5/6 — Concatenating audio parts');
      const rawConcat = path.join(this.tempDir, `concat-raw-${ts}.mp3`);
      tempFiles.push(rawConcat);
      await this.ffmpeg.concatenate(audioParts, rawConcat);
      log.debug('Concatenation done');

      // 6. Final normalization pass on complete episode
      log.info({ targetLufs }, 'Step 6/6 — Final EBU R128 normalization pass');
      await this.normalizer.normalizeFile(rawConcat, outputPath, targetLufs);
      log.debug('Final normalization done');

      // 7. Get final duration
      const durationSeconds = await this.ffmpeg.getDurationSeconds(outputPath);
      log.info({ durationSeconds: durationSeconds.toFixed(1) }, 'Assembly complete');

      return { outputPath, durationSeconds };
    } finally {
      // Clean up all temp files
      log.debug({ count: tempFiles.length }, 'Cleaning up temp files');
      await Promise.all(
        tempFiles.map((f) => unlink(f).catch(() => {}))
      );
    }
  }
}
