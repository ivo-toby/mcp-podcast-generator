import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, copyFile } from 'fs/promises';
import path from 'path';

const exec = promisify(execCb);

export interface NormalizationMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  offset: number;
}

export class FFmpeg {
  constructor(private readonly tempDir: string) {}

  /**
   * Convert raw PCM (24kHz, 16-bit, mono) to MP3.
   * This is the format Gemini TTS outputs.
   */
  async convertPcmToMp3(pcmPath: string, mp3Path: string): Promise<void> {
    await exec(
      `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" -acodec libmp3lame -ab 192k "${mp3Path}"`
    );
  }

  /**
   * Concatenate multiple MP3 files into one, re-encoding to avoid frame boundary issues.
   */
  async concatenate(inputPaths: string[], outputPath: string): Promise<void> {
    if (inputPaths.length === 0) {
      throw new Error('No input files to concatenate');
    }
    if (inputPaths.length === 1) {
      await copyFile(inputPaths[0], outputPath);
      return;
    }

    const listPath = path.join(this.tempDir, `concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const fileList = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listPath, fileList, 'utf8');

    try {
      await exec(
        `ffmpeg -y -f concat -safe 0 -i "${listPath}" -acodec libmp3lame -ab 192k "${outputPath}"`
      );
    } finally {
      await unlink(listPath).catch(() => {});
    }
  }

  /**
   * Apply fade-in and/or fade-out to an audio file.
   */
  async addFade(
    inputPath: string,
    outputPath: string,
    fadeInSecs: number,
    fadeOutSecs: number
  ): Promise<void> {
    if (fadeInSecs === 0 && fadeOutSecs === 0) {
      await copyFile(inputPath, outputPath);
      return;
    }

    const filters: string[] = [];

    if (fadeInSecs > 0) {
      filters.push(`afade=t=in:st=0:d=${fadeInSecs}`);
    }

    if (fadeOutSecs > 0) {
      const duration = await this.getDurationSeconds(inputPath);
      const start = Math.max(0, duration - fadeOutSecs);
      filters.push(`afade=t=out:st=${start.toFixed(3)}:d=${fadeOutSecs}`);
    }

    const filterStr = filters.join(',');
    await exec(`ffmpeg -y -i "${inputPath}" -af "${filterStr}" -acodec libmp3lame -ab 192k "${outputPath}"`);
  }

  /**
   * Measure loudness for EBU R128 normalization (first pass).
   */
  async measureLoudness(inputPath: string): Promise<NormalizationMeasurement> {
    // ffmpeg writes the loudnorm JSON to stderr
    const { stderr } = await exec(
      `ffmpeg -i "${inputPath}" -af loudnorm=I=-16:TP=-1:LRA=11:print_format=json -f null /dev/null`
    ).catch((err) => {
      // ffmpeg exits non-zero for -f null, but stderr has the output
      return { stdout: err.stdout as string, stderr: err.stderr as string };
    });

    // Extract JSON block from stderr
    const jsonMatch = stderr.match(/\{[\s\S]*?"input_thresh"[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`Could not parse loudnorm measurement from ffmpeg output:\n${stderr}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      input_i: string;
      input_tp: string;
      input_lra: string;
      input_thresh: string;
      target_offset: string;
    };

    return {
      inputI: parseFloat(parsed.input_i),
      inputTp: parseFloat(parsed.input_tp),
      inputLra: parseFloat(parsed.input_lra),
      inputThresh: parseFloat(parsed.input_thresh),
      offset: parseFloat(parsed.target_offset),
    };
  }

  /**
   * Apply EBU R128 loudness normalization (second pass using measured values).
   */
  async normalizeLoudness(
    inputPath: string,
    outputPath: string,
    targetLufs: number,
    measurement: NormalizationMeasurement
  ): Promise<void> {
    const filter = [
      `loudnorm=I=${targetLufs}`,
      `TP=-1`,
      `LRA=11`,
      `measured_I=${measurement.inputI}`,
      `measured_TP=${measurement.inputTp}`,
      `measured_LRA=${measurement.inputLra}`,
      `measured_thresh=${measurement.inputThresh}`,
      `offset=${measurement.offset}`,
      `linear=true`,
    ].join(':');

    await exec(`ffmpeg -y -i "${inputPath}" -af "${filter}" -acodec libmp3lame -ab 192k "${outputPath}"`);
  }

  /**
   * Get the duration of an audio file in seconds.
   */
  async getDurationSeconds(filePath: string): Promise<number> {
    const { stdout } = await exec(
      `ffprobe -v quiet -print_format json -show_streams "${filePath}"`
    );
    const data = JSON.parse(stdout) as { streams: Array<{ duration?: string }> };
    const duration = data.streams[0]?.duration;
    if (!duration) {
      throw new Error(`Could not get duration for ${filePath}`);
    }
    return parseFloat(duration);
  }
}
