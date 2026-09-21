import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted — vars used inside vi.mock factories must be declared here
const {
  mockMatchLoudness,
  mockFinalize,
  mockConcatPcm,
  mockAddFade,
  mockDecodeToPcm32,
  mockGetDuration,
  mockDownloadFile,
  mockMkdir,
  mockUnlink,
  mockReadFile,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockMatchLoudness: vi.fn().mockResolvedValue(0),
  mockFinalize: vi.fn().mockResolvedValue(undefined),
  mockConcatPcm: vi.fn().mockResolvedValue(undefined),
  mockAddFade: vi.fn().mockResolvedValue(undefined),
  mockDecodeToPcm32: vi.fn().mockResolvedValue(undefined),
  mockGetDuration: vi.fn().mockResolvedValue(120.5),
  mockDownloadFile: vi.fn(),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/audio/ffmpeg.js', () => ({
  FFmpeg: vi.fn(function () {
    return {
      decodeToPcm32: mockDecodeToPcm32,
      concatPcm: mockConcatPcm,
      addFade: mockAddFade,
      getDurationSeconds: mockGetDuration,
      convertPcmToMp3: vi.fn().mockResolvedValue(undefined),
      measureLoudness: vi.fn().mockResolvedValue({ inputI: -20 }),
      applyGain: vi.fn().mockResolvedValue(undefined),
      applyGainAndLimit: vi.fn().mockResolvedValue(undefined),
      pcmDurationSeconds: vi.fn().mockResolvedValue(60),
    };
  }),
}));

vi.mock('../../src/audio/normalizer.js', () => ({
  Normalizer: vi.fn(function () {
    return {
      matchLoudness: mockMatchLoudness,
      finalize: mockFinalize,
    };
  }),
  WORKING_LEVEL_LUFS: -20,
}));

vi.mock('../../src/utils/download.js', () => ({
  downloadFile: mockDownloadFile,
}));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  unlink: mockUnlink,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  copyFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { Assembler } from '../../src/audio/assembler.js';

describe('Assembler', () => {
  const TEMP_DIR = '/tmp/podcast-test';
  const BASE_OPTIONS = {
    ttsPcmPath: '/tmp/tts.pcm',
    outputPath: '/output/episode.mp3',
    fadeInDuration: 2,
    fadeOutDuration: 3,
    targetLufs: -16,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatchLoudness.mockResolvedValue(0);
    mockFinalize.mockResolvedValue(undefined);
    mockConcatPcm.mockResolvedValue(undefined);
    mockAddFade.mockResolvedValue(undefined);
    mockDecodeToPcm32.mockResolvedValue(undefined);
    mockGetDuration.mockResolvedValue(120.5);
    mockMkdir.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  describe('assembly without music', () => {
    it('concatenates TTS PCM, finalizes, and encodes once', async () => {
      const assembler = new Assembler(TEMP_DIR);
      const result = await assembler.assemble(BASE_OPTIONS);

      expect(mockConcatPcm).toHaveBeenCalledWith(
        [BASE_OPTIONS.ttsPcmPath],
        expect.stringContaining('concat-')
      );
      expect(mockFinalize).toHaveBeenCalledWith(
        expect.stringContaining('concat-'),
        expect.stringContaining('final-'),
        BASE_OPTIONS.targetLufs
      );
      expect(result.outputPath).toBe(BASE_OPTIONS.outputPath);
      expect(result.durationSeconds).toBe(120.5);
    });

    it('never runs a normalization pass on the TTS input', async () => {
      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble(BASE_OPTIONS);

      expect(mockMatchLoudness).not.toHaveBeenCalled();
      expect(mockDecodeToPcm32).not.toHaveBeenCalled();
    });

    it('does not download music or apply fades when no URLs provided', async () => {
      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble(BASE_OPTIONS);

      expect(mockDownloadFile).not.toHaveBeenCalled();
      expect(mockAddFade).not.toHaveBeenCalled();
    });

    it('creates the temp directory', async () => {
      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble(BASE_OPTIONS);

      expect(mockMkdir).toHaveBeenCalledWith(TEMP_DIR, { recursive: true });
    });
  });

  describe('assembly with intro music', () => {
    it('downloads, decodes, matches, fades-in, and prepends intro to parts', async () => {
      mockDownloadFile.mockResolvedValue('/tmp/intro-raw.mp3');
      const assembler = new Assembler(TEMP_DIR);

      await assembler.assemble({
        ...BASE_OPTIONS,
        introMusicUrl: 'https://cdn.example.com/intro.mp3',
      });

      expect(mockDownloadFile).toHaveBeenCalledWith(
        'https://cdn.example.com/intro.mp3',
        TEMP_DIR,
        expect.stringContaining('intro-raw-')
      );
      expect(mockDecodeToPcm32).toHaveBeenCalledWith(
        '/tmp/intro-raw.mp3',
        expect.stringContaining('intro-pcm-')
      );
      expect(mockMatchLoudness).toHaveBeenCalledWith(
        expect.stringContaining('intro-pcm-'),
        expect.stringContaining('intro-matched-'),
        -20
      );
      expect(mockAddFade).toHaveBeenCalledWith(
        expect.stringContaining('intro-matched-'),
        expect.stringContaining('intro-faded-'),
        BASE_OPTIONS.fadeInDuration,
        0
      );
      const [parts] = mockConcatPcm.mock.calls[0] as [string[]];
      expect(parts[0]).toContain('intro-faded-');
    });
  });

  describe('assembly with outro music', () => {
    it('downloads, decodes, matches, fades-out, and appends outro to parts', async () => {
      mockDownloadFile.mockResolvedValue('/tmp/outro-raw.mp3');
      const assembler = new Assembler(TEMP_DIR);

      await assembler.assemble({
        ...BASE_OPTIONS,
        outroMusicUrl: 'https://cdn.example.com/outro.mp3',
      });

      expect(mockDownloadFile).toHaveBeenCalledWith(
        'https://cdn.example.com/outro.mp3',
        TEMP_DIR,
        expect.stringContaining('outro-raw-')
      );
      expect(mockAddFade).toHaveBeenCalledWith(
        expect.stringContaining('outro-matched-'),
        expect.stringContaining('outro-faded-'),
        0,
        BASE_OPTIONS.fadeOutDuration
      );
      const [parts] = mockConcatPcm.mock.calls[0] as [string[]];
      expect(parts[parts.length - 1]).toContain('outro-faded-');
    });
  });

  describe('assembly with intro and outro', () => {
    it('orders parts: intro → tts → outro', async () => {
      mockDownloadFile
        .mockResolvedValueOnce('/tmp/intro-raw.mp3')
        .mockResolvedValueOnce('/tmp/outro-raw.mp3');

      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble({
        ...BASE_OPTIONS,
        introMusicUrl: 'https://cdn.example.com/intro.mp3',
        outroMusicUrl: 'https://cdn.example.com/outro.mp3',
      });

      const [parts] = mockConcatPcm.mock.calls[0] as [string[]];
      expect(parts).toHaveLength(3);
      expect(parts[0]).toContain('intro-faded-');
      expect(parts[1]).toBe(BASE_OPTIONS.ttsPcmPath);
      expect(parts[2]).toContain('outro-faded-');
    });

    it('downloads from both URLs', async () => {
      mockDownloadFile
        .mockResolvedValueOnce('/tmp/intro-raw.mp3')
        .mockResolvedValueOnce('/tmp/outro-raw.mp3');

      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble({
        ...BASE_OPTIONS,
        introMusicUrl: 'https://cdn.example.com/intro.mp3',
        outroMusicUrl: 'https://cdn.example.com/outro.mp3',
      });

      expect(mockDownloadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('temp file cleanup', () => {
    it('deletes music and concat temp files on success but keeps the TTS input', async () => {
      mockDownloadFile.mockResolvedValue('/tmp/intro-raw.mp3');
      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble({
        ...BASE_OPTIONS,
        introMusicUrl: 'https://cdn.example.com/intro.mp3',
      });

      expect(mockUnlink).toHaveBeenCalled();
      const paths = mockUnlink.mock.calls.map(([p]) => p as string);
      expect(paths.some((p) => p.includes('intro-faded-'))).toBe(true);
      expect(paths.some((p) => p.includes('concat-'))).toBe(true);
      expect(paths.some((p) => p.includes('final-'))).toBe(true);
      expect(paths.some((p) => p.includes('/tmp/tts.pcm'))).toBe(false);
    });

    it('cleans up even when the final pass throws', async () => {
      mockFinalize.mockRejectedValueOnce(new Error('final pass failed'));

      const assembler = new Assembler(TEMP_DIR);
      await expect(assembler.assemble(BASE_OPTIONS)).rejects.toThrow('final pass failed');

      expect(mockUnlink).toHaveBeenCalled();
    });

    it('cleans up completed temp files when a later download throws', async () => {
      mockDownloadFile
        .mockResolvedValueOnce('/tmp/intro-raw.mp3')
        .mockRejectedValue(new Error('network error'));

      const assembler = new Assembler(TEMP_DIR);
      await expect(
        assembler.assemble({
          ...BASE_OPTIONS,
          introMusicUrl: 'https://cdn.example.com/intro.mp3',
          outroMusicUrl: 'https://cdn.example.com/outro.mp3',
        })
      ).rejects.toThrow('network error');

      const paths = mockUnlink.mock.calls.map(([p]) => p as string);
      expect(paths.some((p) => p.includes('intro-raw'))).toBe(true);
    });
  });

  describe('return value', () => {
    it('returns outputPath and durationSeconds', async () => {
      mockGetDuration.mockResolvedValue(245.8);

      const assembler = new Assembler(TEMP_DIR);
      const result = await assembler.assemble(BASE_OPTIONS);

      expect(result).toEqual({ outputPath: '/output/episode.mp3', durationSeconds: 245.8 });
    });
  });
});