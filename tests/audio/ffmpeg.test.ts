import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizationMeasurement } from '../../src/audio/ffmpeg.js';

// ---------------------------------------------------------------------------
// Mock child_process — must happen before any module that imports it
// ---------------------------------------------------------------------------

const mockExec = vi.fn();
vi.mock('child_process', () => ({ exec: mockExec }));

// Mock fs/promises
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);
const mockCopyFile = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  unlink: mockUnlink,
  copyFile: mockCopyFile,
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

// Helper: make exec succeed with given stdout/stderr
function execOk(stdout = '', stderr = '') {
  mockExec.mockImplementation(
    (_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
      cb(null, { stdout, stderr })
  );
}

// Helper: make exec fail (simulates ffmpeg -f null exit code 1)
function execFail(stdout = '', stderr = '') {
  mockExec.mockImplementation(
    (_cmd: string, cb: (e: Error & { stdout: string; stderr: string }, r?: unknown) => void) => {
      const err = Object.assign(new Error('ffmpeg exited'), { stdout, stderr });
      cb(err);
    }
  );
}

const LOUDNORM_JSON = JSON.stringify({
  input_i: '-23.50',
  input_tp: '-2.00',
  input_lra: '7.00',
  input_thresh: '-33.50',
  target_offset: '0.50',
});

describe('FFmpeg', () => {
  let FFmpeg: typeof import('../../src/audio/ffmpeg.js').FFmpeg;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ FFmpeg } = await import('../../src/audio/ffmpeg.js'));
  });

  // -------------------------------------------------------------------------
  // convertPcmToMp3
  // -------------------------------------------------------------------------

  describe('convertPcmToMp3', () => {
    it('calls ffmpeg with correct PCM-to-MP3 arguments', async () => {
      execOk();
      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.convertPcmToMp3('/tmp/input.pcm', '/tmp/output.mp3');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-f s16le');
      expect(cmd).toContain('-ar 24000');
      expect(cmd).toContain('-ac 1');
      expect(cmd).toContain('libmp3lame');
      expect(cmd).toContain('"/tmp/input.pcm"');
      expect(cmd).toContain('"/tmp/output.mp3"');
    });
  });

  // -------------------------------------------------------------------------
  // concatenate
  // -------------------------------------------------------------------------

  describe('concatenate', () => {
    it('throws when given an empty array', async () => {
      const ffmpeg = new FFmpeg('/tmp/test');
      await expect(ffmpeg.concatenate([], '/tmp/out.mp3')).rejects.toThrow(
        'No input files to concatenate'
      );
    });

    it('copies directly when only one file is provided', async () => {
      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.concatenate(['/tmp/a.mp3'], '/tmp/out.mp3');

      expect(mockCopyFile).toHaveBeenCalledWith('/tmp/a.mp3', '/tmp/out.mp3');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('writes concat list and runs ffmpeg for multiple files', async () => {
      execOk();
      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.concatenate(['/tmp/a.mp3', '/tmp/b.mp3'], '/tmp/out.mp3');

      // Should have written the list file
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [, listContent] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(listContent).toContain("file '/tmp/a.mp3'");
      expect(listContent).toContain("file '/tmp/b.mp3'");

      // Should have called ffmpeg with concat demuxer
      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-f concat');
      expect(cmd).toContain('-safe 0');
      expect(cmd).toContain('libmp3lame');

      // Should clean up the list file
      expect(mockUnlink).toHaveBeenCalledOnce();
    });

    it('escapes single quotes in file paths', async () => {
      execOk();
      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.concatenate(["/tmp/it's a file.mp3", '/tmp/b.mp3'], '/tmp/out.mp3');

      const [, listContent] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(listContent).toContain("file '/tmp/it'\\''s a file.mp3'");
    });

    it('cleans up list file even when ffmpeg fails', async () => {
      execFail();
      const ffmpeg = new FFmpeg('/tmp/test');
      await expect(
        ffmpeg.concatenate(['/tmp/a.mp3', '/tmp/b.mp3'], '/tmp/out.mp3')
      ).rejects.toThrow();

      expect(mockUnlink).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // addFade
  // -------------------------------------------------------------------------

  describe('addFade', () => {
    it('copies file when both fades are 0', async () => {
      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.addFade('/tmp/in.mp3', '/tmp/out.mp3', 0, 0);

      expect(mockCopyFile).toHaveBeenCalledWith('/tmp/in.mp3', '/tmp/out.mp3');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('applies fade-in filter when only fadeIn > 0', async () => {
      execOk();
      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.addFade('/tmp/in.mp3', '/tmp/out.mp3', 3, 0);

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('afade=t=in:st=0:d=3');
      expect(cmd).not.toContain('afade=t=out');
    });

    it('applies fade-out filter when only fadeOut > 0', async () => {
      // First exec: ffprobe (getDurationSeconds)
      mockExec.mockImplementationOnce(
        (_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: JSON.stringify({ streams: [{ duration: '120.5' }] }), stderr: '' })
      );
      // Second exec: ffmpeg fade
      execOk();

      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.addFade('/tmp/in.mp3', '/tmp/out.mp3', 0, 4);

      const cmd: string = mockExec.mock.calls[1][0];
      expect(cmd).toContain('afade=t=out');
      expect(cmd).toContain('d=4');
      expect(cmd).not.toContain('afade=t=in');
    });

    it('applies both fade-in and fade-out when both > 0', async () => {
      // First exec: ffprobe
      mockExec.mockImplementationOnce(
        (_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: JSON.stringify({ streams: [{ duration: '60.0' }] }), stderr: '' })
      );
      // Second exec: ffmpeg
      execOk();

      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.addFade('/tmp/in.mp3', '/tmp/out.mp3', 2, 3);

      const cmd: string = mockExec.mock.calls[1][0];
      expect(cmd).toContain('afade=t=in:st=0:d=2');
      expect(cmd).toContain('afade=t=out');
    });

    it('clamps fade-out start to 0 when duration < fade duration', async () => {
      mockExec.mockImplementationOnce(
        (_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: JSON.stringify({ streams: [{ duration: '2.0' }] }), stderr: '' })
      );
      execOk();

      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.addFade('/tmp/in.mp3', '/tmp/out.mp3', 0, 5);

      const cmd: string = mockExec.mock.calls[1][0];
      // start = max(0, 2 - 5) = 0
      expect(cmd).toContain('st=0.000');
    });
  });

  // -------------------------------------------------------------------------
  // measureLoudness
  // -------------------------------------------------------------------------

  describe('measureLoudness', () => {
    it('parses loudnorm JSON from ffmpeg stderr', async () => {
      // measureLoudness uses .catch() internally, simulate ffmpeg non-zero exit
      execFail('', `some ffmpeg output\n${LOUDNORM_JSON}\nmore output`);

      const ffmpeg = new FFmpeg('/tmp/test');
      const result = await ffmpeg.measureLoudness('/tmp/in.mp3');

      expect(result.inputI).toBe(-23.5);
      expect(result.inputTp).toBe(-2.0);
      expect(result.inputLra).toBe(7.0);
      expect(result.inputThresh).toBe(-33.5);
      expect(result.offset).toBe(0.5);
    });

    it('also works when ffmpeg exits cleanly (stdout path)', async () => {
      execOk('', `\n${LOUDNORM_JSON}\n`);

      const ffmpeg = new FFmpeg('/tmp/test');
      const result = await ffmpeg.measureLoudness('/tmp/in.mp3');
      expect(result.inputI).toBe(-23.5);
    });

    it('throws when stderr contains no loudnorm JSON block', async () => {
      execFail('', 'Error: file not found');

      const ffmpeg = new FFmpeg('/tmp/test');
      await expect(ffmpeg.measureLoudness('/tmp/in.mp3')).rejects.toThrow(
        'Could not parse loudnorm measurement'
      );
    });
  });

  // -------------------------------------------------------------------------
  // normalizeLoudness
  // -------------------------------------------------------------------------

  describe('normalizeLoudness', () => {
    it('builds a correct loudnorm filter string', async () => {
      execOk();
      const ffmpeg = new FFmpeg('/tmp/test');
      const measurement: NormalizationMeasurement = {
        inputI: -23.5,
        inputTp: -2.0,
        inputLra: 7.0,
        inputThresh: -33.5,
        offset: 0.5,
      };

      await ffmpeg.normalizeLoudness('/tmp/in.mp3', '/tmp/out.mp3', -16, measurement);

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('loudnorm=I=-16');
      expect(cmd).toContain('measured_I=-23.5');
      expect(cmd).toContain('measured_TP=-2');
      expect(cmd).toContain('measured_LRA=7');
      expect(cmd).toContain('linear=true');
      expect(cmd).toContain('"/tmp/in.mp3"');
      expect(cmd).toContain('"/tmp/out.mp3"');
    });
  });

  // -------------------------------------------------------------------------
  // getDurationSeconds
  // -------------------------------------------------------------------------

  describe('getDurationSeconds', () => {
    it('parses duration from ffprobe JSON output', async () => {
      execOk(JSON.stringify({ streams: [{ duration: '245.3' }] }));

      const ffmpeg = new FFmpeg('/tmp/test');
      const duration = await ffmpeg.getDurationSeconds('/tmp/test.mp3');

      expect(duration).toBe(245.3);
    });

    it('throws when streams array is empty', async () => {
      execOk(JSON.stringify({ streams: [] }));

      const ffmpeg = new FFmpeg('/tmp/test');
      await expect(ffmpeg.getDurationSeconds('/tmp/test.mp3')).rejects.toThrow(
        'Could not get duration'
      );
    });

    it('throws when stream has no duration field', async () => {
      execOk(JSON.stringify({ streams: [{ codec_type: 'audio' }] }));

      const ffmpeg = new FFmpeg('/tmp/test');
      await expect(ffmpeg.getDurationSeconds('/tmp/test.mp3')).rejects.toThrow(
        'Could not get duration'
      );
    });

    it('calls ffprobe with the correct file path', async () => {
      execOk(JSON.stringify({ streams: [{ duration: '10.0' }] }));

      const ffmpeg = new FFmpeg('/tmp/test');
      await ffmpeg.getDurationSeconds('/tmp/my-audio.mp3');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('ffprobe');
      expect(cmd).toContain('"/tmp/my-audio.mp3"');
      expect(cmd).toContain('-print_format json');
      expect(cmd).toContain('-show_streams');
    });
  });
});
