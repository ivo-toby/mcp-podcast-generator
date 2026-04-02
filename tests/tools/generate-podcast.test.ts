import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeneratePodcastInput } from '../../src/tools/generate-podcast.js';

// ---------------------------------------------------------------------------
// vi.hoisted — mocks referenced inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockGenerateSingleHost, mockGenerateDualHost, mockAssemble } = vi.hoisted(() => ({
  mockGenerateSingleHost: vi.fn().mockResolvedValue(undefined),
  mockGenerateDualHost: vi.fn().mockResolvedValue(undefined),
  mockAssemble: vi.fn().mockResolvedValue({
    outputPath: '/output/episode.mp3',
    durationSeconds: 120.0,
  }),
}));

vi.mock('../../src/tts/gemini-client.js', () => ({
  GeminiTTSClient: vi.fn(function() { return ({
    generateSingleHost: mockGenerateSingleHost,
    generateDualHost: mockGenerateDualHost,
  }); }),
  formatScript: vi.fn((segments: Array<{ speaker?: string; text: string }>, type: string) =>
    type === 'single'
      ? segments.map((s) => s.text).join('\n\n')
      : segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
  ),
}));

vi.mock('../../src/audio/assembler.js', () => ({
  Assembler: vi.fn(function() { return ({
    assemble: mockAssemble,
  }); }),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe('GeneratePodcastInput schema', () => {
  const minimalSingle = {
    type: 'single' as const,
    hosts: [{ name: 'Alex', voice: 'Charon' }],
    segments: [{ text: 'Hello world.' }],
    outputFilename: 'episode.mp3',
  };

  const minimalDual = {
    type: 'dual' as const,
    hosts: [
      { name: 'Alex', voice: 'Charon' },
      { name: 'Sam', voice: 'Puck' },
    ],
    segments: [
      { speaker: 'Alex', text: 'Hello.' },
      { speaker: 'Sam', text: 'Hi there.' },
    ],
    outputFilename: 'episode.mp3',
  };

  it('accepts valid single-host input', () => {
    expect(() => GeneratePodcastInput.parse(minimalSingle)).not.toThrow();
  });

  it('accepts valid dual-host input', () => {
    expect(() => GeneratePodcastInput.parse(minimalDual)).not.toThrow();
  });

  it('applies defaults: fadeIn=2, fadeOut=3, targetLufs=-16', () => {
    const result = GeneratePodcastInput.parse(minimalSingle);
    expect(result.fadeInDuration).toBe(2);
    expect(result.fadeOutDuration).toBe(3);
    expect(result.targetLufs).toBe(-16);
  });

  it('accepts custom fade and LUFS values', () => {
    const result = GeneratePodcastInput.parse({
      ...minimalSingle,
      fadeInDuration: 5,
      fadeOutDuration: 10,
      targetLufs: -23,
    });
    expect(result.fadeInDuration).toBe(5);
    expect(result.fadeOutDuration).toBe(10);
    expect(result.targetLufs).toBe(-23);
  });

  it('accepts valid HTTPS music URLs', () => {
    const result = GeneratePodcastInput.parse({
      ...minimalSingle,
      introMusicUrl: 'https://cdn.example.com/intro.mp3',
      outroMusicUrl: 'https://cdn.example.com/outro.mp3',
    });
    expect(result.introMusicUrl).toBe('https://cdn.example.com/intro.mp3');
  });

  it('rejects invalid music URLs', () => {
    expect(() =>
      GeneratePodcastInput.parse({ ...minimalSingle, introMusicUrl: 'not-a-url' })
    ).toThrow();
  });

  it('rejects empty hosts array', () => {
    expect(() => GeneratePodcastInput.parse({ ...minimalSingle, hosts: [] })).toThrow();
  });

  it('rejects more than 2 hosts', () => {
    expect(() =>
      GeneratePodcastInput.parse({
        ...minimalSingle,
        hosts: [
          { name: 'A', voice: 'Charon' },
          { name: 'B', voice: 'Puck' },
          { name: 'C', voice: 'Kore' },
        ],
      })
    ).toThrow();
  });

  it('rejects empty segments array', () => {
    expect(() => GeneratePodcastInput.parse({ ...minimalSingle, segments: [] })).toThrow();
  });

  it('rejects LUFS above -5', () => {
    expect(() => GeneratePodcastInput.parse({ ...minimalSingle, targetLufs: -4 })).toThrow();
  });

  it('rejects LUFS below -40', () => {
    expect(() => GeneratePodcastInput.parse({ ...minimalSingle, targetLufs: -41 })).toThrow();
  });

  it('rejects fadeInDuration above 30', () => {
    expect(() => GeneratePodcastInput.parse({ ...minimalSingle, fadeInDuration: 31 })).toThrow();
  });

  it('rejects empty host name', () => {
    expect(() =>
      GeneratePodcastInput.parse({ ...minimalSingle, hosts: [{ name: '', voice: 'Charon' }] })
    ).toThrow();
  });

  it('rejects empty segment text', () => {
    expect(() =>
      GeneratePodcastInput.parse({ ...minimalSingle, segments: [{ text: '' }] })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// generatePodcast function
// ---------------------------------------------------------------------------

describe('generatePodcast', () => {
  const config = {
    googleApiKey: 'test-api-key',
    outputDir: '/output',
    tempDir: '/tmp/test',
  };

  const singleHostInput = {
    type: 'single' as const,
    hosts: [{ name: 'Alex', voice: 'Charon' }],
    segments: [{ text: 'Hello, welcome to the show.' }],
    outputFilename: 'episode.mp3',
    fadeInDuration: 2,
    fadeOutDuration: 3,
    targetLufs: -16,
  };

  const dualHostInput = {
    type: 'dual' as const,
    hosts: [
      { name: 'Alex', voice: 'Charon' },
      { name: 'Sam', voice: 'Puck' },
    ],
    segments: [
      { speaker: 'Alex', text: 'Hello!' },
      { speaker: 'Sam', text: 'Hi there!' },
    ],
    outputFilename: 'episode-dual.mp3',
    fadeInDuration: 2,
    fadeOutDuration: 3,
    targetLufs: -16,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssemble.mockResolvedValue({ outputPath: '/output/episode.mp3', durationSeconds: 120.0 });
    mockGenerateSingleHost.mockResolvedValue(undefined);
    mockGenerateDualHost.mockResolvedValue(undefined);
  });

  it('calls generateSingleHost for single-host input', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await generatePodcast(singleHostInput, config);

    expect(mockGenerateSingleHost).toHaveBeenCalledOnce();
    expect(mockGenerateDualHost).not.toHaveBeenCalled();
  });

  it('calls generateDualHost for dual-host input', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await generatePodcast(dualHostInput, config);

    expect(mockGenerateDualHost).toHaveBeenCalledOnce();
    expect(mockGenerateSingleHost).not.toHaveBeenCalled();
  });

  it('passes both host configs to generateDualHost', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await generatePodcast(dualHostInput, config);

    const [, hosts] = mockGenerateDualHost.mock.calls[0] as [string, Array<{ name: string }>];
    expect(hosts).toHaveLength(2);
    expect(hosts[0].name).toBe('Alex');
    expect(hosts[1].name).toBe('Sam');
  });

  it('returns success: true with outputPath and durationSeconds', async () => {
    mockAssemble.mockResolvedValue({ outputPath: '/output/episode.mp3', durationSeconds: 245.3 });
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    const result = await generatePodcast(singleHostInput, config);

    expect(result).toEqual({ success: true, outputPath: '/output/episode.mp3', durationSeconds: 245.3 });
  });

  it('throws when dual mode has only 1 host', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await expect(
      generatePodcast({ ...dualHostInput, hosts: [{ name: 'Alex', voice: 'Charon' }] }, config)
    ).rejects.toThrow('Dual-host mode requires exactly 2 hosts');
  });

  it('throws when a dual-host segment has no speaker', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await expect(
      generatePodcast({ ...dualHostInput, segments: [{ text: 'No speaker.' }] }, config)
    ).rejects.toThrow('requires all segments to have a speaker field');
  });

  it('throws when a segment speaker does not match any configured host', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await expect(
      generatePodcast({ ...dualHostInput, segments: [{ speaker: 'Ghost', text: 'Who am I?' }] }, config)
    ).rejects.toThrow('does not match any configured host');
  });

  it('passes music URLs and audio options through to assembler', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await generatePodcast(
      {
        ...singleHostInput,
        introMusicUrl: 'https://cdn.example.com/intro.mp3',
        outroMusicUrl: 'https://cdn.example.com/outro.mp3',
        fadeInDuration: 5,
        fadeOutDuration: 8,
        targetLufs: -23,
      },
      config
    );

    const assembleArg = mockAssemble.mock.calls[0][0] as {
      introMusicUrl: string;
      outroMusicUrl: string;
      fadeInDuration: number;
      fadeOutDuration: number;
      targetLufs: number;
    };
    expect(assembleArg.introMusicUrl).toBe('https://cdn.example.com/intro.mp3');
    expect(assembleArg.outroMusicUrl).toBe('https://cdn.example.com/outro.mp3');
    expect(assembleArg.fadeInDuration).toBe(5);
    expect(assembleArg.fadeOutDuration).toBe(8);
    expect(assembleArg.targetLufs).toBe(-23);
  });

  it('resolves outputFilename relative to outputDir', async () => {
    const { generatePodcast } = await import('../../src/tools/generate-podcast.js');
    await generatePodcast({ ...singleHostInput, outputFilename: 'my-episode.mp3' }, config);

    const assembleArg = mockAssemble.mock.calls[0][0] as { outputPath: string };
    expect(assembleArg.outputPath).toBe('/output/my-episode.mp3');
  });
});
