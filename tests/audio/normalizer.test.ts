import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Normalizer } from '../../src/audio/normalizer.js';
import type { FFmpeg, NormalizationMeasurement } from '../../src/audio/ffmpeg.js';

// ---------------------------------------------------------------------------
// Mock fs/promises (used via dynamic import inside normalizer)
// ---------------------------------------------------------------------------

const mockCopyFile = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  copyFile: mockCopyFile,
  rename: mockRename,
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Build a mock FFmpeg instance
// ---------------------------------------------------------------------------

function makeMockFFmpeg(measurement: Partial<NormalizationMeasurement> = {}): FFmpeg {
  const defaultMeasurement: NormalizationMeasurement = {
    inputI: -23.5,
    inputTp: -2.0,
    inputLra: 7.0,
    inputThresh: -33.5,
    offset: 0.5,
    ...measurement,
  };
  return {
    measureLoudness: vi.fn().mockResolvedValue(defaultMeasurement),
    normalizeLoudness: vi.fn().mockResolvedValue(undefined),
    convertPcmToMp3: vi.fn().mockResolvedValue(undefined),
    concatenate: vi.fn().mockResolvedValue(undefined),
    addFade: vi.fn().mockResolvedValue(undefined),
    getDurationSeconds: vi.fn().mockResolvedValue(60),
  } as unknown as FFmpeg;
}

describe('Normalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // normalizeFile
  // -------------------------------------------------------------------------

  describe('normalizeFile', () => {
    it('copies file directly when loudness is within 1 dB of target', async () => {
      // inputI = -16.5, target = -16 → diff = 0.5 < 1.0 → skip
      const ffmpeg = makeMockFFmpeg({ inputI: -16.5 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.normalizeFile('/tmp/in.mp3', '/tmp/out.mp3', -16);

      expect(mockCopyFile).toHaveBeenCalledWith('/tmp/in.mp3', '/tmp/out.mp3');
      expect(ffmpeg.normalizeLoudness).not.toHaveBeenCalled();
    });

    it('copies when loudness exactly matches target', async () => {
      const ffmpeg = makeMockFFmpeg({ inputI: -16.0 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.normalizeFile('/tmp/in.mp3', '/tmp/out.mp3', -16);

      expect(mockCopyFile).toHaveBeenCalledOnce();
      expect(ffmpeg.normalizeLoudness).not.toHaveBeenCalled();
    });

    it('normalizes when loudness is more than 1 dB below target', async () => {
      // inputI = -20, target = -16 → diff = 4.0 ≥ 1.0 → normalize
      const ffmpeg = makeMockFFmpeg({ inputI: -20.0 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.normalizeFile('/tmp/in.mp3', '/tmp/out.mp3', -16);

      expect(ffmpeg.normalizeLoudness).toHaveBeenCalledWith(
        '/tmp/in.mp3',
        '/tmp/out.mp3',
        -16,
        expect.objectContaining({ inputI: -20.0 })
      );
      expect(mockCopyFile).not.toHaveBeenCalled();
    });

    it('normalizes when loudness is more than 1 dB above target', async () => {
      // inputI = -10, target = -16 → diff = 6.0 ≥ 1.0 → normalize
      const ffmpeg = makeMockFFmpeg({ inputI: -10.0 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.normalizeFile('/tmp/in.mp3', '/tmp/out.mp3', -16);

      expect(ffmpeg.normalizeLoudness).toHaveBeenCalledOnce();
      expect(mockCopyFile).not.toHaveBeenCalled();
    });

    it('uses -16 LUFS as default target', async () => {
      const ffmpeg = makeMockFFmpeg({ inputI: -20.0 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.normalizeFile('/tmp/in.mp3', '/tmp/out.mp3');

      expect(ffmpeg.normalizeLoudness).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        -16,
        expect.any(Object)
      );
    });

    it('passes measurement values to normalizeLoudness', async () => {
      const measurement: NormalizationMeasurement = {
        inputI: -25.0,
        inputTp: -3.0,
        inputLra: 8.0,
        inputThresh: -35.0,
        offset: 0.2,
      };
      const ffmpeg = makeMockFFmpeg(measurement);
      const normalizer = new Normalizer(ffmpeg, '/tmp/test');

      await normalizer.normalizeFile('/tmp/in.mp3', '/tmp/out.mp3', -16);

      expect(ffmpeg.normalizeLoudness).toHaveBeenCalledWith(
        '/tmp/in.mp3',
        '/tmp/out.mp3',
        -16,
        expect.objectContaining(measurement)
      );
    });
  });

  // -------------------------------------------------------------------------
  // normalizeInPlace
  // -------------------------------------------------------------------------

  describe('normalizeInPlace', () => {
    it('normalizes to a temp file then renames to original path', async () => {
      const ffmpeg = makeMockFFmpeg({ inputI: -20.0 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/podcast-gen');

      await normalizer.normalizeInPlace('/tmp/my-audio.mp3');

      // normalizeLoudness should have been called with a temp path
      const normCall = (ffmpeg.normalizeLoudness as ReturnType<typeof vi.fn>).mock.calls[0];
      const [inputPath, tempPath] = normCall as [string, string];
      expect(inputPath).toBe('/tmp/my-audio.mp3');
      expect(tempPath).toContain('/tmp/podcast-gen/norm-');
      expect(tempPath).toMatch(/\.mp3$/);

      // Should rename temp → original
      expect(mockRename).toHaveBeenCalledWith(tempPath, '/tmp/my-audio.mp3');
    });

    it('uses a unique temp file name on each call', async () => {
      const ffmpeg = makeMockFFmpeg({ inputI: -20.0 });
      const normalizer = new Normalizer(ffmpeg, '/tmp/podcast-gen');

      await normalizer.normalizeInPlace('/tmp/audio.mp3');
      await normalizer.normalizeInPlace('/tmp/audio.mp3');

      const firstTempPath = (ffmpeg.normalizeLoudness as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const secondTempPath = (ffmpeg.normalizeLoudness as ReturnType<typeof vi.fn>).mock.calls[1][1] as string;
      expect(firstTempPath).not.toBe(secondTempPath);
    });
  });
});
