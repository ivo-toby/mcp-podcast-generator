import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process — must happen before any module that imports it
// ---------------------------------------------------------------------------

const mockExec = vi.fn();
vi.mock('child_process', () => ({ exec: mockExec }));

// Mock fs/promises
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockResolvedValue(Buffer.alloc(0));
const mockUnlink = vi.fn().mockResolvedValue(undefined);
const mockCopyFile = vi.fn().mockResolvedValue(undefined);
const mockStat = vi.fn().mockResolvedValue({ size: 24000 * 4 * 10 }); // 10s of f32le

vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  copyFile: mockCopyFile,
  stat: mockStat,
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
    mockStat.mockResolvedValue({ size: 24000 * 4 * 10 });
    ({ FFmpeg } = await import('../../src/audio/ffmpeg.js'));
  });

  // -------------------------------------------------------------------------
  // convertPcmToMp3
  // -------------------------------------------------------------------------

  describe('convertPcmToMp3', () => {
    it('defaults to f32le PCM input', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.convertPcmToMp3('/tmp/input.pcm', '/tmp/output.mp3');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-f f32le');
      expect(cmd).toContain('-ar 24000');
      expect(cmd).toContain('-ac 1');
      expect(cmd).toContain('libmp3lame');
      expect(cmd).toContain('"/tmp/input.pcm"');
      expect(cmd).toContain('"/tmp/output.mp3"');
    });

    it('accepts s16le PCM input', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.convertPcmToMp3('/tmp/input.pcm', '/tmp/output.mp3', 's16le');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-f s16le');
      expect(cmd).not.toContain('-f f32le');
    });
  });

  // -------------------------------------------------------------------------
  // decodeToPcm32
  // -------------------------------------------------------------------------

  describe('decodeToPcm32', () => {
    it('decodes any input to f32le mono 24kHz', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.decodeToPcm32('/tmp/music.mp3', '/tmp/out.pcm');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-i "/tmp/music.mp3"');
      expect(cmd).toContain('-ac 1');
      expect(cmd).toContain('-ar 24000');
      expect(cmd).toContain('-f f32le');
      expect(cmd).toContain('pcm_f32le');
      expect(cmd).toContain('"/tmp/out.pcm"');
    });
  });

  // -------------------------------------------------------------------------
  // measureLoudness
  // -------------------------------------------------------------------------

  describe('measureLoudness', () => {
    it('parses loudnorm JSON from ffmpeg stderr', async () => {
      // measureLoudness uses .catch() internally, simulate ffmpeg non-zero exit
      execFail('', `some ffmpeg output\n${LOUDNORM_JSON}\nmore output`);

      const ffmpeg = new FFmpeg();
      const result = await ffmpeg.measureLoudness('/tmp/in.pcm');

      expect(result.inputI).toBe(-23.5);
      expect(result.inputTp).toBe(-2.0);
      expect(result.inputLra).toBe(7.0);
      expect(result.inputThresh).toBe(-33.5);
    });

    it('passes raw PCM input args for the measured format', async () => {
      execOk('', `\n${LOUDNORM_JSON}\n`);

      const ffmpeg = new FFmpeg();
      await ffmpeg.measureLoudness('/tmp/in.pcm', 's16le');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-f s16le -ar 24000 -ac 1 -i "/tmp/in.pcm"');
      expect(cmd).toContain('loudnorm');
      expect(cmd).toContain('print_format=json');
    });

    it('throws when stderr contains no loudnorm JSON block', async () => {
      execFail('', 'Error: file not found');

      const ffmpeg = new FFmpeg();
      await expect(ffmpeg.measureLoudness('/tmp/in.pcm')).rejects.toThrow(
        'Could not parse loudnorm measurement'
      );
    });
  });

  // -------------------------------------------------------------------------
  // applyGain
  // -------------------------------------------------------------------------

  describe('applyGain', () => {
    it('applies a static volume gain and outputs f32le', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.applyGain('/tmp/in.pcm', 3.25, '/tmp/out.pcm');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-af "volume=3.25dB"');
      expect(cmd).toContain('-f f32le -c:a pcm_f32le');
      expect(cmd).not.toContain('loudnorm');
    });

    it('supports s16le input format', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.applyGain('/tmp/in.pcm', -2, '/tmp/out.pcm', 's16le');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-f s16le');
      expect(cmd).toContain('volume=-2dB');
    });
  });

  // -------------------------------------------------------------------------
  // applyGainAndLimit
  // -------------------------------------------------------------------------

  describe('applyGainAndLimit', () => {
    it('chains static gain with a lookahead limiter at the ceiling', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.applyGainAndLimit('/tmp/in.pcm', 4, -1.5, '/tmp/out.pcm');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('volume=4dB');
      // -1.5 dBFS as linear amplitude
      expect(cmd).toContain('alimiter=limit=0.8414');
      expect(cmd).toContain('level=false');
      expect(cmd).toContain('attack=5');
      expect(cmd).toContain('release=50');
      expect(cmd).not.toContain('loudnorm');
    });
  });

  // -------------------------------------------------------------------------
  // addFade
  // -------------------------------------------------------------------------

  describe('addFade', () => {
    it('copies file when both fades are 0', async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.addFade('/tmp/in.pcm', '/tmp/out.pcm', 0, 0);

      expect(mockCopyFile).toHaveBeenCalledWith('/tmp/in.pcm', '/tmp/out.pcm');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('applies fade-in filter when only fadeIn > 0', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.addFade('/tmp/in.pcm', '/tmp/out.pcm', 3, 0);

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('afade=t=in:st=0:d=3');
      expect(cmd).not.toContain('afade=t=out');
    });

    it('applies fade-out based on PCM file size duration', async () => {
      execOk();
      // 10s of f32le PCM; fade-out of 4s starts at 6s
      const ffmpeg = new FFmpeg();
      await ffmpeg.addFade('/tmp/in.pcm', '/tmp/out.pcm', 0, 4);

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('afade=t=out:st=6.000:d=4');
      expect(cmd).not.toContain('afade=t=in');
    });

    it('applies both fade-in and fade-out when both > 0', async () => {
      execOk();
      const ffmpeg = new FFmpeg();
      await ffmpeg.addFade('/tmp/in.pcm', '/tmp/out.pcm', 2, 3);

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('afade=t=in:st=0:d=2');
      expect(cmd).toContain('afade=t=out:st=7.000:d=3');
    });

    it('clamps fade-out start to 0 when duration < fade duration', async () => {
      execOk();
      mockStat.mockResolvedValue({ size: 24000 * 4 * 2 }); // 2s of audio

      const ffmpeg = new FFmpeg();
      await ffmpeg.addFade('/tmp/in.pcm', '/tmp/out.pcm', 0, 5);

      const cmd: string = mockExec.mock.calls[0][0];
      // start = max(0, 2 - 5) = 0
      expect(cmd).toContain('st=0.000');
    });
  });

  // -------------------------------------------------------------------------
  // concatPcm
  // -------------------------------------------------------------------------

  describe('concatPcm', () => {
    it('throws when given an empty array', async () => {
      const ffmpeg = new FFmpeg();
      await expect(ffmpeg.concatPcm([], '/tmp/out.pcm')).rejects.toThrow(
        'No input files to concatenate'
      );
    });

    it('copies directly when only one file is provided', async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.concatPcm(['/tmp/a.pcm'], '/tmp/out.pcm');

      expect(mockCopyFile).toHaveBeenCalledWith('/tmp/a.pcm', '/tmp/out.pcm');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('byte-concatenates multiple PCM files', async () => {
      mockReadFile
        .mockResolvedValueOnce(Buffer.from([1, 2]))
        .mockResolvedValueOnce(Buffer.from([3, 4]));

      const ffmpeg = new FFmpeg();
      await ffmpeg.concatPcm(['/tmp/a.pcm', '/tmp/b.pcm'], '/tmp/out.pcm');

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/out.pcm', Buffer.from([1, 2, 3, 4]));
    });
  });

  // -------------------------------------------------------------------------
  // pcmDurationSeconds
  // -------------------------------------------------------------------------

  describe('pcmDurationSeconds', () => {
    it('derives duration from file size', async () => {
      mockStat.mockResolvedValue({ size: 24000 * 4 * 12.5 });

      const ffmpeg = new FFmpeg();
      const duration = await ffmpeg.pcmDurationSeconds('/tmp/in.pcm');

      expect(duration).toBe(12.5);
    });
  });

  // -------------------------------------------------------------------------
  // getDurationSeconds
  // -------------------------------------------------------------------------

  describe('getDurationSeconds', () => {
    it('parses duration from ffprobe JSON output', async () => {
      execOk(JSON.stringify({ streams: [{ duration: '245.3' }] }));

      const ffmpeg = new FFmpeg();
      const duration = await ffmpeg.getDurationSeconds('/tmp/test.mp3');

      expect(duration).toBe(245.3);
    });

    it('throws when streams array is empty', async () => {
      execOk(JSON.stringify({ streams: [] }));

      const ffmpeg = new FFmpeg();
      await expect(ffmpeg.getDurationSeconds('/tmp/test.mp3')).rejects.toThrow(
        'Could not get duration'
      );
    });

    it('throws when stream has no duration field', async () => {
      execOk(JSON.stringify({ streams: [{ codec_type: 'audio' }] }));

      const ffmpeg = new FFmpeg();
      await expect(ffmpeg.getDurationSeconds('/tmp/test.mp3')).rejects.toThrow(
        'Could not get duration'
      );
    });

    it('calls ffprobe with the correct file path', async () => {
      execOk(JSON.stringify({ streams: [{ duration: '10.0' }] }));

      const ffmpeg = new FFmpeg();
      await ffmpeg.getDurationSeconds('/tmp/my-audio.mp3');

      const cmd: string = mockExec.mock.calls[0][0];
      expect(cmd).toContain('ffprobe');
      expect(cmd).toContain('"/tmp/my-audio.mp3"');
      expect(cmd).toContain('-print_format json');
      expect(cmd).toContain('-show_streams');
    });
  });
});