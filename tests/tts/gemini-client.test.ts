import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatScript,
  chunkDialogue,
  chunkMonologue,
  resolveChunkTargetWords,
} from '../../src/tts/gemini-client.js';

// ---------------------------------------------------------------------------
// formatScript — pure function tests
// ---------------------------------------------------------------------------

describe('formatScript', () => {
  describe('single host', () => {
    it('joins segment texts with double newlines', () => {
      const segments = [
        { text: 'Hello and welcome.' },
        { text: 'Today we cover AI.' },
        { text: 'Thanks for listening.' },
      ];
      expect(formatScript(segments, 'single')).toBe(
        'Hello and welcome.\n\nToday we cover AI.\n\nThanks for listening.'
      );
    });

    it('ignores the speaker field', () => {
      const segments = [
        { speaker: 'Alex', text: 'Hello.' },
        { speaker: 'Sam', text: 'World.' },
      ];
      expect(formatScript(segments, 'single')).toBe('Hello.\n\nWorld.');
    });

    it('returns a single segment without extra newlines', () => {
      expect(formatScript([{ text: 'Only one.' }], 'single')).toBe('Only one.');
    });

    it('returns empty string for empty segments', () => {
      expect(formatScript([], 'single')).toBe('');
    });
  });

  describe('dual host', () => {
    it('formats each line as "Speaker: text"', () => {
      const segments = [
        { speaker: 'Alex', text: 'Welcome to the show.' },
        { speaker: 'Sam', text: 'Great to be here.' },
        { speaker: 'Alex', text: "Let's get started." },
      ];
      expect(formatScript(segments, 'dual')).toBe(
        "Alex: Welcome to the show.\nSam: Great to be here.\nAlex: Let's get started."
      );
    });

    it('returns empty string for empty segments', () => {
      expect(formatScript([], 'dual')).toBe('');
    });

    it('handles a single segment', () => {
      expect(formatScript([{ speaker: 'Alex', text: 'Just me.' }], 'dual')).toBe('Alex: Just me.');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveChunkTargetWords — TTS_CHUNK_TARGET_WORDS override with sane bounds
// ---------------------------------------------------------------------------

describe('resolveChunkTargetWords', () => {
  it('returns the default when the env var is unset', () => {
    expect(resolveChunkTargetWords({})).toBe(450);
  });

  it('returns a valid override', () => {
    expect(resolveChunkTargetWords({ TTS_CHUNK_TARGET_WORDS: '300' })).toBe(300);
  });

  it('falls back to the default for non-numeric or out-of-range values', () => {
    expect(resolveChunkTargetWords({ TTS_CHUNK_TARGET_WORDS: 'abc' })).toBe(450);
    expect(resolveChunkTargetWords({ TTS_CHUNK_TARGET_WORDS: '10' })).toBe(450);
    expect(resolveChunkTargetWords({ TTS_CHUNK_TARGET_WORDS: '900' })).toBe(450);
    expect(resolveChunkTargetWords({ TTS_CHUNK_TARGET_WORDS: '-5' })).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// chunkDialogue / chunkMonologue — keep each TTS call inside Gemini's
// ~5min/quality envelope by capping spoken-word count per chunk.
// ---------------------------------------------------------------------------

describe('chunkDialogue', () => {
  it('returns a single chunk when total words are under the budget', () => {
    const dialogue = 'Alex: Hi.\nSam: Hello there.';
    expect(chunkDialogue(dialogue, 250)).toEqual([dialogue]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkDialogue('', 250)).toEqual([]);
    expect(chunkDialogue('   \n  \n', 250)).toEqual([]);
  });

  it('splits at speaker-turn boundaries when budget is exceeded', () => {
    const lines = [
      'Alex: ' + 'word '.repeat(34).trim(),
      'Sam: ' + 'word '.repeat(34).trim(),
      'Alex: ' + 'word '.repeat(34).trim(),
      'Sam: ' + 'word '.repeat(34).trim(),
    ];
    const chunks = chunkDialogue(lines.join('\n'), 80);
    // Each line is 35 words; 80-word budget fits 2 lines (70w) but not 3 (105w)
    expect(chunks).toHaveLength(2);
    expect(chunks[0].split('\n')).toHaveLength(2);
    expect(chunks[1].split('\n')).toHaveLength(2);
  });

  it('emits an over-budget single line as its own chunk rather than splitting mid-utterance', () => {
    const longLine = 'Alex: ' + 'word '.repeat(300).trim();
    const shortLine = 'Sam: short reply.';
    const chunks = chunkDialogue([longLine, shortLine].join('\n'), 100);
    expect(chunks[0]).toBe(longLine);
    expect(chunks[chunks.length - 1]).toBe(shortLine);
  });
});

describe('chunkMonologue', () => {
  it('returns a single chunk when total words are under the budget', () => {
    const text = 'Hello and welcome.\n\nToday we cover AI.';
    expect(chunkMonologue(text, 250)).toEqual([text]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkMonologue('', 250)).toEqual([]);
  });

  it('splits at paragraph boundaries when budget is exceeded', () => {
    const para = (n: number) => `paragraph${n} ` + 'word '.repeat(34).trim();
    const text = [para(1), para(2), para(3), para(4)].join('\n\n');
    const chunks = chunkMonologue(text, 80);
    // Each paragraph 35 words, budget 80 -> 2 paragraphs per chunk
    expect(chunks).toHaveLength(2);
    expect(chunks[0].split(/\n\n+/)).toHaveLength(2);
  });

  it('falls back to sentence-level splitting for an over-budget paragraph', () => {
    // Single paragraph, no \n\n separators, 200 words total in 4 sentences.
    const sentence = 'word '.repeat(50).trim() + '.';
    const text = [sentence, sentence, sentence, sentence].join(' ');
    const chunks = chunkMonologue(text, 80);
    // 4 sentences x 51 words each, budget 80 -> 1 sentence per chunk
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('joins sentence sub-chunks with spaces, not paragraph breaks', () => {
    // One over-budget paragraph (2 sentences, 60 words each = 120 words, budget 80).
    // Each sentence fits, so each becomes its own chunk — but the joiner between
    // sub-chunks must not introduce \n\n paragraph pauses within what was
    // originally a single paragraph.
    const sentence = (tag: string) => tag + ' ' + 'word '.repeat(58).trim() + '.';
    const para = [sentence('A'), sentence('B')].join(' ');
    const chunks = chunkMonologue(para, 80);
    for (const chunk of chunks) {
      expect(chunk).not.toContain('\n\n');
    }
  });

  it('does not merge sentence sub-chunks with adjacent short paragraphs via \\n\\n', () => {
    // Oversize paragraph followed by a short one. The short paragraph must not
    // be appended to a sentence sub-chunk using \n\n.
    const longSentence = 'word '.repeat(90).trim() + '.';
    const shortPara = 'short tail paragraph.';
    const text = `${longSentence}\n\n${shortPara}`;
    const chunks = chunkMonologue(text, 80);
    // None of the chunks should fuse the oversize-paragraph output with the
    // short paragraph via a paragraph break.
    for (const chunk of chunks) {
      if (chunk.includes(shortPara) && chunk.includes('word')) {
        // Short paragraph cohabiting with sentence content -> bug
        expect(chunk).not.toContain('\n\n');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// GeminiTTSClient — mock the Google Generative AI SDK
// ---------------------------------------------------------------------------

const { mockGenerateContent, mockGetGenerativeModel, mockExec, mockWriteFile, mockReadFile } =
  vi.hoisted(() => {
    const mockGenerateContent = vi.fn();
    const mockGetGenerativeModel = vi.fn(() => ({ generateContent: mockGenerateContent }));
    const mockExec = vi.fn(
      (_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
        if (_cmd.includes('loudnorm')) {
          const json = JSON.stringify({
            input_i: '-23.50',
            input_tp: '-2.00',
            input_lra: '7.00',
            input_thresh: '-33.50',
            target_offset: '0.50',
          });
          cb(null, { stdout: '', stderr: `ffmpeg output\n${json}\n` });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
    );
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    const mockReadFile = vi.fn().mockResolvedValue(Buffer.from('leveled-pcm'));
    return { mockGenerateContent, mockGetGenerativeModel, mockExec, mockWriteFile, mockReadFile };
  });

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(function() { return ({
    getGenerativeModel: mockGetGenerativeModel,
  }); }),
}));

vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  exec: mockExec,
}));

describe('GeminiTTSClient', () => {
  const makeAudioResponse = (base64Data: string) => ({
    response: {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: base64Data } }],
          },
        },
      ],
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('calls generateContent for single host and uses single-voice config', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm-data').toString('base64'))
    );

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await client.generateSingleHost('Hello world', { name: 'Alex', voice: 'Charon' }, '/tmp/out.pcm', '/tmp/test');

    expect(mockGetGenerativeModel).toHaveBeenCalledOnce();
    const config = mockGetGenerativeModel.mock.calls[0][0] as {
      model: string;
      generationConfig: { speechConfig: { voiceConfig?: unknown; multiSpeakerVoiceConfig?: unknown } };
    };
    expect(config.model).toBe('gemini-2.5-flash-preview-tts');
    expect(config.generationConfig.speechConfig).toHaveProperty('voiceConfig');
    expect(config.generationConfig.speechConfig).not.toHaveProperty('multiSpeakerVoiceConfig');
    expect(mockGenerateContent).toHaveBeenCalledWith('Hello world');
  });

  it('uses multiSpeakerVoiceConfig for dual host with correct speaker names', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm-data').toString('base64'))
    );

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    const hosts: [{ name: string; voice: string }, { name: string; voice: string }] = [
      { name: 'Alex', voice: 'Charon' },
      { name: 'Sam', voice: 'Puck' },
    ];
    await client.generateDualHost('Alex: Hi\nSam: Hello', hosts, '/tmp/out.pcm', '/tmp/test');

    const config = mockGetGenerativeModel.mock.calls[0][0] as {
      generationConfig: {
        speechConfig: {
          multiSpeakerVoiceConfig: { speakerVoiceConfigs: Array<{ speaker: string; voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }> };
        };
      };
    };
    const speakerConfigs = config.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs;
    expect(speakerConfigs).toHaveLength(2);
    expect(speakerConfigs[0]).toMatchObject({ speaker: 'Alex', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } });
    expect(speakerConfigs[1]).toMatchObject({ speaker: 'Sam', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } });
  });

  it('throws a clear error when the script is whitespace-only (zero chunks)', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    const client = new GeminiTTSClient('test-api-key', '/tmp/test');

    await expect(
      client.generateSingleHost('   \n  \n ', { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test')
    ).rejects.toThrow(/empty script/i);

    // Must NOT have called the TTS API or written anything with empty PCM
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('throws when Gemini returns no candidates', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue({ response: { candidates: [] } });

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await expect(
      client.generateSingleHost('Hi', { name: 'Alex', voice: 'Charon' }, '/tmp/out.pcm', '/tmp/test')
    ).rejects.toThrow('Gemini TTS returned no content parts');
  });

  it('throws when response parts contain no audio data', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue({
      response: { candidates: [{ content: { parts: [{ text: 'no audio' }] } }] },
    });

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await expect(
      client.generateSingleHost('Hi', { name: 'Alex', voice: 'Charon' }, '/tmp/out.pcm', '/tmp/test')
    ).rejects.toThrow('Gemini TTS returned no audio data in response parts');
  });

  it('chunks long scripts into multiple TTS calls to stay inside the quality envelope', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm-data').toString('base64'))
    );

    // 8 paragraphs of 200 words each = 1600 words; 450-word budget -> >1 chunk
    const paragraph = 'word '.repeat(200).trim() + '.';
    const longText = Array(8).fill(paragraph).join('\n\n');
    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await client.generateSingleHost(longText, { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test');

    // Should call the TTS API multiple times rather than blasting the whole script in one go
    expect(mockGenerateContent.mock.calls.length).toBeGreaterThan(1);
  });

  it('concatenates audio across multiple inlineData parts in a single response', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { data: Buffer.from('AAAA').toString('base64') } },
                { inlineData: { data: Buffer.from('BBBB').toString('base64') } },
              ],
            },
          },
        ],
      },
    });

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    // Should not throw — both parts are accepted and concatenated
    await client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test');
    expect(mockGenerateContent).toHaveBeenCalledOnce();
  });

  it('level-matches each chunk with a static gain and writes raw PCM (no MP3 in TTS)', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm-data').toString('base64'))
    );

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test');

    const cmds = mockExec.mock.calls.map((c) => c[0] as string);

    // One loudnorm measurement per chunk, on the raw s16le PCM Gemini returns
    const measureCmds = cmds.filter((c) => c.includes('loudnorm'));
    expect(measureCmds).toHaveLength(1);
    expect(measureCmds[0]).toContain('-f s16le');

    // Static gain to the -20 LUFS working level: -23.5 measured → +3.5 dB
    const gainCmds = cmds.filter((c) => c.includes('volume='));
    expect(gainCmds).toHaveLength(1);
    expect(gainCmds[0]).toContain('volume=3.5dB');
    expect(gainCmds[0]).toContain('-f f32le');

    // No lossy encode inside the TTS client — the assembler does the single encode
    expect(cmds.some((c) => c.includes('libmp3lame'))).toBe(false);

    // Output is the raw PCM buffer, written to the requested .pcm path
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/out.pcm', Buffer.from('leveled-pcm'));
  });

  it('uses a custom model when specified', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm').toString('base64'))
    );

    const client = new GeminiTTSClient('key', '/tmp/test', 'gemini-custom-model');
    await client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test');

    expect(mockGetGenerativeModel.mock.calls[0][0]).toMatchObject({ model: 'gemini-custom-model' });
  });

  describe('chunk retry', () => {
    it('retries once and succeeds when a chunk call fails transiently', async () => {
      const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
      mockGenerateContent
        .mockRejectedValueOnce(new Error('503 upstream'))
        .mockResolvedValue(makeAudioResponse(Buffer.from('pcm').toString('base64')));

      const client = new GeminiTTSClient('test-api-key', '/tmp/test');
      await client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test');

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('fails after the single retry when both attempts fail', async () => {
      const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
      mockGenerateContent.mockRejectedValue(new Error('429 quota'));

      const client = new GeminiTTSClient('test-api-key', '/tmp/test');
      await expect(
        client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.pcm', '/tmp/test')
      ).rejects.toThrow('429 quota');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
  });
});
