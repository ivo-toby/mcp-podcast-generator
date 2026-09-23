import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { unlink, copyFile, stat } from 'fs/promises';
import path from 'path';

const exec = promisify(execCb);

export interface LoudnessMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
}

export type PcmFormat = 's16le' | 'f32le';

/**
 * Sample format of the audio pipeline: 24kHz mono.
 * Intermediates are float32 PCM so gain stages cannot clip; the only integer
 * PCM (and the only lossy encode) is the final MP3 write.
 */
export const PCM_SAMPLE_RATE = 24000;

export class FFmpeg {
  private pcmInputArgs(format: PcmFormat): string {
    return `-f ${format} -ar ${PCM_SAMPLE_RATE} -ac 1`;
  }

  /**
   * Encode raw PCM to MP3. This is the pipeline's single lossy encode —
   * every stage before it works on raw PCM.
   */
  async convertPcmToMp3(
    pcmPath: string,
    mp3Path: string,
    inputFormat: PcmFormat = 'f32le'
  ): Promise<void> {
    await exec(
      `ffmpeg -y ${this.pcmInputArgs(inputFormat)} -i "${pcmPath}" -acodec libmp3lame -ab 192k "${mp3Path}"`
    );
  }

  /**
   * Decode any audio file (mp3, wav, ...) to raw f32le mono PCM at the
   * pipeline sample rate, so all mixing happens in one float domain.
   */
  async decodeToPcm32(inputPath: string, outputPath: string): Promise<void> {
    await exec(
      `ffmpeg -y -i "${inputPath}" -vn -ac 1 -ar ${PCM_SAMPLE_RATE} -f f32le -c:a pcm_f32le "${outputPath}"`
    );
  }

  /**
   * Measure EBU R128 loudness of a raw PCM file (loudnorm first pass).
   */
  async measureLoudness(
    inputPath: string,
    inputFormat: PcmFormat = 'f32le'
  ): Promise<LoudnessMeasurement> {
    const { stderr } = await exec(
      `ffmpeg -hide_banner ${this.pcmInputArgs(inputFormat)} -i "${inputPath}" -af loudnorm=I=-16:TP=-1:LRA=11:print_format=json -f null /dev/null`
    ).catch((err) => {
      // ffmpeg exits non-zero for -f null, but stderr has the output
      return { stdout: err.stdout as string, stderr: err.stderr as string };
    });

    const jsonMatch = stderr.match(/\{[\s\S]*?"input_thresh"[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`Could not parse loudnorm measurement from ffmpeg output:\n${stderr}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      input_i: string;
      input_tp: string;
      input_lra: string;
      input_thresh: string;
    };

    return {
      inputI: parseFloat(parsed.input_i),
      inputTp: parseFloat(parsed.input_tp),
      inputLra: parseFloat(parsed.input_lra),
      inputThresh: parseFloat(parsed.input_thresh),
    };
  }

  /**
   * Apply static gain to raw PCM, outputting f32le. Static gain only — no
   * dynamic processing, so the material's loudness range is preserved.
   */
  async applyGain(
    inputPath: string,
    gainDb: number,
    outputPath: string,
    inputFormat: PcmFormat = 'f32le'
  ): Promise<void> {
    await exec(
      `ffmpeg -y ${this.pcmInputArgs(inputFormat)} -i "${inputPath}" -af "volume=${gainDb}dB" -f f32le -c:a pcm_f32le "${outputPath}"`
    );
  }

  /**
   * Static gain followed by a lookahead limiter ceiling. The limiter only
   * touches isolated peaks above the ceiling, unlike broadband dynamic
   * normalization which compresses everything continuously.
   */
  async applyGainAndLimit(
    inputPath: string,
    gainDb: number,
    ceilingDb: number,
    outputPath: string
  ): Promise<void> {
    // alimiter takes a linear amplitude; level=false disables its auto-level.
    const limitAmp = Math.pow(10, ceilingDb / 20).toFixed(4);
    await exec(
      `ffmpeg -y ${this.pcmInputArgs('f32le')} -i "${inputPath}" -af "volume=${gainDb}dB,alimiter=limit=${limitAmp}:attack=5:release=50:level=false" -f f32le -c:a pcm_f32le "${outputPath}"`
    );
  }

  /**
   * Apply fade-in and/or fade-out to raw f32le PCM.
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
      const duration = await this.pcmDurationSeconds(inputPath);
      const start = Math.max(0, duration - fadeOutSecs);
      filters.push(`afade=t=out:st=${start.toFixed(3)}:d=${fadeOutSecs}`);
    }

    const filterStr = filters.join(',');
    await exec(
      `ffmpeg -y ${this.pcmInputArgs('f32le')} -i "${inputPath}" -af "${filterStr}" -f f32le -c:a pcm_f32le "${outputPath}"`
    );
  }

  /**
   * Concatenate same-format raw PCM files by byte concatenation. All parts
   * must already be f32le mono PCM — format mismatches would corrupt audio.
   * Streams parts sequentially so peak memory stays constant regardless of
   * episode length; buffering the whole episode twice can exceed the
   * container's memory limit on long jobs.
   */
  async concatPcm(inputPaths: string[], outputPath: string): Promise<void> {
    if (inputPaths.length === 0) {
      throw new Error('No input files to concatenate');
    }
    if (inputPaths.length === 1) {
      await copyFile(inputPaths[0], outputPath);
      return;
    }

    for (let i = 0; i < inputPaths.length; i++) {
      const flags = i === 0 ? 'w' : 'a';
      await pipeline(
        createReadStream(inputPaths[i]),
        createWriteStream(outputPath, { flags })
      );
    }
  }

  /**
   * Duration of a raw PCM file, derived from file size (no container header).
   */
  async pcmDurationSeconds(filePath: string, bytesPerSample = 4): Promise<number> {
    const { size } = await stat(filePath);
    return size / (bytesPerSample * PCM_SAMPLE_RATE);
  }

  /**
   * Get the duration of a container audio file (e.g. MP3) in seconds.
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