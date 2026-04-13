import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatScript, chunkDialogue, chunkMonologue } from '../../src/tts/gemini-client.js';

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
});

// ---------------------------------------------------------------------------
// GeminiTTSClient — mock the Google Generative AI SDK
// ---------------------------------------------------------------------------

const { mockGenerateContent, mockGetGenerativeModel } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn(() => ({ generateContent: mockGenerateContent }));
  return { mockGenerateContent, mockGetGenerativeModel };
});

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(function() { return ({
    getGenerativeModel: mockGetGenerativeModel,
  }); }),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: '', stderr: '' })
  ),
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
    await client.generateSingleHost('Hello world', { name: 'Alex', voice: 'Charon' }, '/tmp/out.mp3', '/tmp/test');

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
    await client.generateDualHost('Alex: Hi\nSam: Hello', hosts, '/tmp/out.mp3', '/tmp/test');

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

  it('throws when Gemini returns no candidates', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue({ response: { candidates: [] } });

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await expect(
      client.generateSingleHost('Hi', { name: 'Alex', voice: 'Charon' }, '/tmp/out.mp3', '/tmp/test')
    ).rejects.toThrow('Gemini TTS returned no content parts');
  });

  it('throws when response parts contain no audio data', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue({
      response: { candidates: [{ content: { parts: [{ text: 'no audio' }] } }] },
    });

    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await expect(
      client.generateSingleHost('Hi', { name: 'Alex', voice: 'Charon' }, '/tmp/out.mp3', '/tmp/test')
    ).rejects.toThrow('Gemini TTS returned no audio data in response parts');
  });

  it('chunks long scripts into multiple TTS calls to stay inside the quality envelope', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm-data').toString('base64'))
    );

    // 8 paragraphs of 200 words each = 1600 words; 250-word budget -> >1 chunk
    const paragraph = 'word '.repeat(200).trim() + '.';
    const longText = Array(8).fill(paragraph).join('\n\n');
    const client = new GeminiTTSClient('test-api-key', '/tmp/test');
    await client.generateSingleHost(longText, { name: 'Alex', voice: 'Kore' }, '/tmp/out.mp3', '/tmp/test');

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
    await client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.mp3', '/tmp/test');
    expect(mockGenerateContent).toHaveBeenCalledOnce();
  });

  it('uses a custom model when specified', async () => {
    const { GeminiTTSClient } = await import('../../src/tts/gemini-client.js');
    mockGenerateContent.mockResolvedValue(
      makeAudioResponse(Buffer.from('pcm').toString('base64'))
    );

    const client = new GeminiTTSClient('key', '/tmp/test', 'gemini-custom-model');
    await client.generateSingleHost('Hi', { name: 'Alex', voice: 'Kore' }, '/tmp/out.mp3', '/tmp/test');

    expect(mockGetGenerativeModel.mock.calls[0][0]).toMatchObject({ model: 'gemini-custom-model' });
  });
});
