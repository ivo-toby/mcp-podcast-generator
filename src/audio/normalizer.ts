import { FFmpeg, type LoudnessMeasurement, type PcmFormat } from './ffmpeg.js';
import path from 'path';
import { rename } from 'fs/promises';

/**
 * Working loudness level every mix part is matched to before concatenation.
 * Well below the publish target so the final static gain has clean headroom
 * and the limiter only ever touches isolated true peaks.
 */
export const WORKING_LEVEL_LUFS = -20;

/** Sample-peak ceiling for the final lookahead limiter, dBFS. */
const LIMITER_CEILING_DB = -1.5;

/** Integrated-loudness tolerance before the final pass applies a correction. */
const LUFS_TOLERANCE = 0.5;

/** loudnorm reports -70 or worse for silence; below this there is nothing to match. */
const SILENCE_FLOOR_LUFS = -70;

function gainForTarget(measurement: LoudnessMeasurement, targetLufs: number): number {
  const inputI = measurement.inputI;
  if (!Number.isFinite(inputI) || inputI <= SILENCE_FLOOR_LUFS) {
    return 0;
  }
  return Math.round((targetLufs - inputI) * 100) / 100;
}

export class Normalizer {
  constructor(private readonly ffmpeg: FFmpeg, private readonly tempDir: string) {}

  /**
   * Static-gain loudness match on raw PCM. Never dynamic: the material's
   * loudness range is preserved, only the overall level moves. Output is
   * always f32le mono PCM. Returns the applied gain in dB (0 for silence).
   */
  async matchLoudness(
    inputPcm: string,
    outputPcm: string,
    targetLufs: number,
    inputFormat: PcmFormat = 'f32le'
  ): Promise<number> {
    const measurement = await this.ffmpeg.measureLoudness(inputPcm, inputFormat);
    const gainDb = gainForTarget(measurement, targetLufs);
    await this.ffmpeg.applyGain(inputPcm, gainDb, outputPcm, inputFormat);
    return gainDb;
  }

  /**
   * Final mix pass: static gain to the publish target, then a lookahead
   * limiter that only touches isolated peaks above the ceiling. Re-measures
   * and applies one corrective gain if gating or limiting shifted the
   * integrated loudness beyond tolerance. Output is f32le mono PCM.
   */
  async finalize(inputPcm: string, outputPcm: string, targetLufs: number): Promise<void> {
    const measurement = await this.ffmpeg.measureLoudness(inputPcm, 'f32le');
    const gainDb = gainForTarget(measurement, targetLufs);
    await this.ffmpeg.applyGainAndLimit(inputPcm, gainDb, LIMITER_CEILING_DB, outputPcm);

    const verified = await this.ffmpeg.measureLoudness(outputPcm, 'f32le');
    const drift = verified.inputI - targetLufs;
    if (!Number.isFinite(verified.inputI) || verified.inputI <= SILENCE_FLOOR_LUFS) {
      return;
    }
    if (Math.abs(drift) > LUFS_TOLERANCE) {
      const correction = Math.round(-drift * 100) / 100;
      const correctedPath = path.join(
        this.tempDir,
        `finalize-correction-${Date.now()}-${Math.random().toString(36).slice(2)}.pcm`
      );
      await this.ffmpeg.applyGain(outputPcm, correction, correctedPath);
      await rename(correctedPath, outputPcm);
    }
  }
}