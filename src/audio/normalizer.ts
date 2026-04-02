import { FFmpeg } from './ffmpeg.js';
import path from 'path';

export class Normalizer {
  constructor(private readonly ffmpeg: FFmpeg, private readonly tempDir: string) {}

  /**
   * Normalize an audio file to a target LUFS level using EBU R128 two-pass normalization.
   * Returns path to normalized file (may be outputPath or a temp file).
   */
  async normalizeFile(
    inputPath: string,
    outputPath: string,
    targetLufs: number = -16
  ): Promise<void> {
    // First pass: measure loudness
    const measurement = await this.ffmpeg.measureLoudness(inputPath);

    // Skip normalization if already close enough (within 1 dB)
    if (Math.abs(measurement.inputI - targetLufs) < 1.0) {
      const { copyFile } = await import('fs/promises');
      await copyFile(inputPath, outputPath);
      return;
    }

    // Second pass: apply normalization
    await this.ffmpeg.normalizeLoudness(inputPath, outputPath, targetLufs, measurement);
  }

  /**
   * Normalize with a temporary intermediate file, replacing the source.
   */
  async normalizeInPlace(filePath: string, targetLufs: number = -16): Promise<void> {
    const tempPath = path.join(
      this.tempDir,
      `norm-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`
    );
    await this.normalizeFile(filePath, tempPath, targetLufs);
    const { rename } = await import('fs/promises');
    await rename(tempPath, filePath);
  }
}
