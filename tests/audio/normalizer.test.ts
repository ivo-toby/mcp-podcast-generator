import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Normalizer } from '../../src/audio/normalizer.js';
import { WORKING_LEVEL_LUFS } from '../../src/audio/normalizer.js';
import type { FFmpeg, LoudnessMeasurement, PcmFormat } from '../../src/audio/ffmpeg.js';

// ---------------------------------------------------------------------------
// Mock fs/promises (rename used by the finalize corrective pass)
// ---------------------------------------------------------------------------

const { mockRename } = vi.hoisted(() => ({ mockRename: vi.fn().mockResolvedValue(undefined) }));

vi.mock('fs/promises', () => ({
  copyFile: vi.fn().mockResolvedValue(undefined),
  rename: mockRename,
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
}));

// ---------------------------------------------------------------------------
// Build a mock FFmpeg instance
// ---------------------------------------------------------------------------

function makeMockFFmpeg(measurements: LoudnessMeasurement[]): FFmpeg {
  let call = 0;
  return {
    measureLoudness: vi.fn().mockImplementation(() => {
      const m = measurements[Math.min(call, measurements.length - 1)];
      call++;
      return Promise.resolve(m);
    }),
    applyGain: vi.fn().mockResolvedValue(undefined),
    applyGainAndLimit: vi.fn().mockResolvedValue(undefined),
    convertPcmToMp3: vi.fn().mockResolvedValue(undefined),
    addFade: vi.fn().mockResolvedValue(undefined),
    getDurationSeconds: vi.fn().mockResolvedValue(60),
    pcmDurationSeconds: vi.fn().mockResolvedValue(60),
    decodeToPcm32: vi.fn().mockResolvedValue(undefined),
    concatPcm: vi.fn().mockResolvedValue(undefined),
  } as unknown as FFmpeg;
}

const measurement = (inputI: number): LoudnessMeasurement => ({
  inputI,
  inputTp: -2.0,
  inputLra: 7.0,
  inputThresh: -33.5,
});

describe('Normalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRename.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // WORKING_LEVEL_LUFS
  // -------------------------------------------------------------------------

  it('exposes -20 LUFS as the working level', () => {
    expect(WORKING_LEVEL_LUFS).toBe(-20);
  });

  // -------------------------------------------------------------------------
  // matchLoudness
  // -------------------------------------------------------------------------

  describe('matchLoudness', () => {
    it('applies the exact static gain to reach the target', async () => {
      // inputI = -23.5, target = -20 → gain = +3.5
      const ffmpeg = makeMockFFmpeg([measurement(-23.5)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      const gain = await normalizer.matchLoudness('/tmp/in.pcm', '/tmp/out.pcm', -20);

      expect(gain).toBe(3.5);
      expect(ffmpeg.applyGain).toHaveBeenCalledWith('/tmp/in.pcm', 3.5, '/tmp/out.pcm', 'f32le');
      expect(ffmpeg.applyGainAndLimit).not.toHaveBeenCalled();
    });

    it('measures with the given input format', async () => {
      const ffmpeg = makeMockFFmpeg([measurement(-20)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.matchLoudness('/tmp/in.pcm', '/tmp/out.pcm', -20, 's16le');

      expect(ffmpeg.measureLoudness).toHaveBeenCalledWith('/tmp/in.pcm', 's16le');
      // No gain needed — still applies volume=0 for format conversion
      expect(ffmpeg.applyGain).toHaveBeenCalledWith('/tmp/in.pcm', 0, '/tmp/out.pcm', 's16le');
    });

    it('applies zero gain for silent input instead of amplifying noise', async () => {
      const ffmpeg = makeMockFFmpeg([measurement(-70)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      const gain = await normalizer.matchLoudness('/tmp/in.pcm', '/tmp/out.pcm', -20);

      expect(gain).toBe(0);
      expect(ffmpeg.applyGain).toHaveBeenCalledWith(
        '/tmp/in.pcm',
        0,
        '/tmp/out.pcm',
        'f32le'
      );
    });

    it('never applies dynamic normalization', async () => {
      const ffmpeg = makeMockFFmpeg([measurement(-40)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.matchLoudness('/tmp/in.pcm', '/tmp/out.pcm', -16);

      expect(ffmpeg.applyGainAndLimit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // finalize
  // -------------------------------------------------------------------------

  describe('finalize', () => {
    it('applies static gain plus limiter to reach the publish target', async () => {
      // First measure: -22 → gain +6. Verify measure: -16.2 (within 0.5) → no correction
      const ffmpeg = makeMockFFmpeg([measurement(-22), measurement(-16.2)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.finalize('/tmp/in.pcm', '/tmp/out.pcm', -16);

      expect(ffmpeg.applyGainAndLimit).toHaveBeenCalledWith('/tmp/in.pcm', 6, -1.5, '/tmp/out.pcm');
      expect(ffmpeg.measureLoudness).toHaveBeenCalledTimes(2);
      // Verified result within tolerance — no corrective pass
      expect(ffmpeg.applyGain).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('applies a corrective gain when the result drifts beyond tolerance', async () => {
      // First measure: -22 → gain +6. Verify measure: -15.2 (0.8 off) → correction -0.8
      const ffmpeg = makeMockFFmpeg([measurement(-22), measurement(-15.2)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.finalize('/tmp/in.pcm', '/tmp/out.pcm', -16);

      expect(ffmpeg.applyGain).toHaveBeenCalledWith(
        '/tmp/out.pcm',
        -0.8,
        expect.stringContaining('/tmp/test/')
      );
      expect(mockRename).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/test/'),
        '/tmp/out.pcm'
      );
    });

    it('skips the corrective pass when drift is within tolerance', async () => {
      // Verify measure: -15.7 (0.3 off) → no correction
      const ffmpeg = makeMockFFmpeg([measurement(-22), measurement(-15.7)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.finalize('/tmp/in.pcm', '/tmp/out.pcm', -16);

      expect(ffmpeg.applyGain).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('does not correct when the limited output is silent', async () => {
      const ffmpeg = makeMockFFmpeg([measurement(-22), measurement(-70)]);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.finalize('/tmp/in.pcm', '/tmp/out.pcm', -16);

      expect(ffmpeg.applyGain).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });
  });
});