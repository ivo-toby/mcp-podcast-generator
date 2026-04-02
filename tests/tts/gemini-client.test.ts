import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatScript } from '../../src/tts/gemini-client.js';

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
