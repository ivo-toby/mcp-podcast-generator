import { mkdir, unlink } from 'fs/promises';
import path from 'path';
import { FFmpeg } from './ffmpeg.js';
import { Normalizer, WORKING_LEVEL_LUFS } from './normalizer.js';
import { downloadFile } from '../utils/download.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('assembler');

export interface AssemblyOptions {
  /** Level-matched f32le mono PCM produced by the TTS client. */
  ttsPcmPath: string;
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
    this.ffmpeg = new FFmpeg();
    this.normalizer = new Normalizer(this.ffmpeg, tempDir);
  }

  async assemble(options: AssemblyOptions): Promise<AssemblyResult> {
    const {
      ttsPcmPath,
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
    const pcmParts: string[] = [];

    try {
      // 1. Intro music (if provided): decode → loudness match → fade-in
      if (introMusicUrl) {
        log.info({ url: introMusicUrl }, 'Step 1/5 — Preparing intro music');
        const introRaw = await downloadFile(introMusicUrl, this.tempDir, `intro-raw-${ts}`);
        tempFiles.push(introRaw);

        const introPcm = path.join(this.tempDir, `intro-pcm-${ts}.pcm`);
        tempFiles.push(introPcm);
        await this.ffmpeg.decodeToPcm32(introRaw, introPcm);

        const introMatched = path.join(this.tempDir, `intro-matched-${ts}.pcm`);
        tempFiles.push(introMatched);
        await this.normalizer.matchLoudness(introPcm, introMatched, WORKING_LEVEL_LUFS);

        const introFaded = path.join(this.tempDir, `intro-faded-${ts}.pcm`);
        tempFiles.push(introFaded);
        await this.ffmpeg.addFade(introMatched, introFaded, fadeInDuration, 0);
        pcmParts.push(introFaded);
        log.debug('Intro music ready');
      } else {
        log.debug('Step 1/5 — No intro music, skipping');
      }

      // 2. TTS audio (already level-matched per chunk by the TTS client)
      log.debug('Step 2/5 — Adding TTS PCM to mix');
      pcmParts.push(ttsPcmPath);

      // 3. Outro music (if provided): decode → loudness match → fade-out
      if (outroMusicUrl) {
        log.info({ url: outroMusicUrl }, 'Step 3/5 — Preparing outro music');
        const outroRaw = await downloadFile(outroMusicUrl, this.tempDir, `outro-raw-${ts}`);
        tempFiles.push(outroRaw);

        const outroPcm = path.join(this.tempDir, `outro-pcm-${ts}.pcm`);
        tempFiles.push(outroPcm);
        await this.ffmpeg.decodeToPcm32(outroRaw, outroPcm);

        const outroMatched = path.join(this.tempDir, `outro-matched-${ts}.pcm`);
        tempFiles.push(outroMatched);
        await this.normalizer.matchLoudness(outroPcm, outroMatched, WORKING_LEVEL_LUFS);

        const outroFaded = path.join(this.tempDir, `outro-faded-${ts}.pcm`);
        tempFiles.push(outroFaded);
        await this.ffmpeg.addFade(outroMatched, outroFaded, 0, fadeOutDuration);
        pcmParts.push(outroFaded);
        log.debug('Outro music ready');
      } else {
        log.debug('Step 3/5 — No outro music, skipping');
      }

      // 4. Concatenate all parts at PCM level, then single final pass:
      //    static gain to target + true-peak limiter. No dynamic processing.
      log.info({ parts: pcmParts.length }, 'Step 4/5 — Concatenating PCM parts');
      const concatPcm = path.join(this.tempDir, `concat-${ts}.pcm`);
      tempFiles.push(concatPcm);
      await this.ffmpeg.concatPcm(pcmParts, concatPcm);

      log.info({ targetLufs }, 'Final loudness pass (static gain + peak limiter)');
      const finalPcm = path.join(this.tempDir, `final-${ts}.pcm`);
      tempFiles.push(finalPcm);
      await this.normalizer.finalize(concatPcm, finalPcm, targetLufs);

      // 5. The single lossy encode of the whole pipeline
      log.info('Step 5/5 — Encoding MP3');
      await this.ffmpeg.convertPcmToMp3(finalPcm, outputPath, 'f32le');
      log.debug('MP3 encode done');

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