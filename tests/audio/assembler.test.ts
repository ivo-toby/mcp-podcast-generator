import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted — vars used inside vi.mock factories must be declared here
const {
  mockNormalizeFile,
  mockConcatenate,
  mockAddFade,
  mockGetDuration,
  mockDownloadFile,
  mockMkdir,
  mockUnlink,
} = vi.hoisted(() => ({
  mockNormalizeFile: vi.fn().mockResolvedValue(undefined),
  mockConcatenate: vi.fn().mockResolvedValue(undefined),
  mockAddFade: vi.fn().mockResolvedValue(undefined),
  mockGetDuration: vi.fn().mockResolvedValue(120.5),
  mockDownloadFile: vi.fn(),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/audio/ffmpeg.js', () => ({
  FFmpeg: vi.fn(function() { return ({
    concatenate: mockConcatenate,
    addFade: mockAddFade,
    getDurationSeconds: mockGetDuration,
    convertPcmToMp3: vi.fn().mockResolvedValue(undefined),
    measureLoudness: vi.fn().mockResolvedValue({ inputI: -20 }),
    normalizeLoudness: vi.fn().mockResolvedValue(undefined),
  }); }),
}));

vi.mock('../../src/audio/normalizer.js', () => ({
  Normalizer: vi.fn(function() { return ({
    normalizeFile: mockNormalizeFile,
  }); }),
}));

vi.mock('../../src/utils/download.js', () => ({
  downloadFile: mockDownloadFile,
}));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  unlink: mockUnlink,
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { Assembler } from '../../src/audio/assembler.js';

describe('Assembler', () => {
  const TEMP_DIR = '/tmp/podcast-test';
  const BASE_OPTIONS = {
    ttsAudioPath: '/tmp/tts.mp3',
    outputPath: '/output/episode.mp3',
    fadeInDuration: 2,
    fadeOutDuration: 3,
    targetLufs: -16,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizeFile.mockResolvedValue(undefined);
    mockConcatenate.mockResolvedValue(undefined);
    mockAddFade.mockResolvedValue(undefined);
    mockGetDuration.mockResolvedValue(120.5);
    mockMkdir.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  describe('assembly without music', () => {
    it('normalizes TTS, concatenates, normalizes final output', async () => {
      const assembler = new Assembler(TEMP_DIR);
      const result = await assembler.assemble(BASE_OPTIONS);

      expect(mockNormalizeFile).toHaveBeenCalledWith(
        BASE_OPTIONS.ttsAudioPath,
        expect.stringContaining('tts-norm-'),
        BASE_OPTIONS.targetLufs
      );
      expect(mockConcatenate).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining('tts-norm-')]),
        expect.stringContaining('concat-raw-')
      );
      expect(mockNormalizeFile).toHaveBeenCalledWith(
        expect.stringContaining('concat-raw-'),
        BASE_OPTIONS.outputPath,
        BASE_OPTIONS.targetLufs
      );
      expect(result.outputPath).toBe(BASE_OPTIONS.outputPath);
      expect(result.durationSeconds).toBe(120.5);
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
    it('downloads, fades-in, and prepends intro to concat list', async () => {
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
      expect(mockAddFade).toHaveBeenCalledWith(
        '/tmp/intro-raw.mp3',
        expect.stringContaining('intro-faded-'),
        BASE_OPTIONS.fadeInDuration,
        0
      );
      const [parts] = mockConcatenate.mock.calls[0] as [string[]];
      expect(parts[0]).toContain('intro-faded-');
    });
  });

  describe('assembly with outro music', () => {
    it('downloads, fades-out, and appends outro to concat list', async () => {
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
        '/tmp/outro-raw.mp3',
        expect.stringContaining('outro-faded-'),
        0,
        BASE_OPTIONS.fadeOutDuration
      );
      const [parts] = mockConcatenate.mock.calls[0] as [string[]];
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

      const [parts] = mockConcatenate.mock.calls[0] as [string[]];
      expect(parts).toHaveLength(3);
      expect(parts[0]).toContain('intro-faded-');
      expect(parts[1]).toContain('tts-norm-');
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
    it('deletes tts-norm and concat-raw temp files on success', async () => {
      const assembler = new Assembler(TEMP_DIR);
      await assembler.assemble(BASE_OPTIONS);

      expect(mockUnlink).toHaveBeenCalled();
      const paths = mockUnlink.mock.calls.map(([p]) => p as string);
      expect(paths.some((p) => p.includes('tts-norm-'))).toBe(true);
      expect(paths.some((p) => p.includes('concat-raw-'))).toBe(true);
    });

    it('cleans up even when normalization throws', async () => {
      mockNormalizeFile.mockRejectedValueOnce(new Error('normalization failed'));

      const assembler = new Assembler(TEMP_DIR);
      await expect(assembler.assemble(BASE_OPTIONS)).rejects.toThrow('normalization failed');

      expect(mockUnlink).toHaveBeenCalled();
    });

    it('cleans up even when download throws', async () => {
      mockDownloadFile.mockRejectedValue(new Error('network error'));

      const assembler = new Assembler(TEMP_DIR);
      await expect(
        assembler.assemble({ ...BASE_OPTIONS, introMusicUrl: 'https://cdn.example.com/intro.mp3' })
      ).rejects.toThrow('network error');

      expect(mockUnlink).toHaveBeenCalled();
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
