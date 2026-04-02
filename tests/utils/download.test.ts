import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

// Real HTTP server + real temp dir — tests actual I/O, no mocking needed

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('downloadFile', () => {
  let tmpDir: string;
  let closeServer: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'download-test-'));
  });

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Successful downloads
  // -------------------------------------------------------------------------

  it('downloads a file and returns the destination path', async () => {
    const { baseUrl, close } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('fake audio data');
    });
    closeServer = close;

    const { downloadFile } = await import('../../src/utils/download.js');
    const result = await downloadFile(`${baseUrl}/episode.mp3`, tmpDir, 'audio');

    expect(result).toMatch(/audio\.mp3$/);
    const content = await readFile(result, 'utf8');
    expect(content).toBe('fake audio data');
  });

  it('extracts the correct extension from the URL path', async () => {
    const { baseUrl, close } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('wav data');
    });
    closeServer = close;

    const { downloadFile } = await import('../../src/utils/download.js');
    const result = await downloadFile(`${baseUrl}/music/intro.wav`, tmpDir, 'intro');

    expect(result).toMatch(/intro\.wav$/);
  });

  it('defaults to .mp3 when URL has no extension', async () => {
    const { baseUrl, close } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('audio');
    });
    closeServer = close;

    const { downloadFile } = await import('../../src/utils/download.js');
    const result = await downloadFile(`${baseUrl}/stream`, tmpDir, 'my-file');

    expect(result).toMatch(/my-file\.mp3$/);
  });

  it('writes the file into the destination directory', async () => {
    const { baseUrl, close } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('data');
    });
    closeServer = close;

    const { downloadFile } = await import('../../src/utils/download.js');
    const result = await downloadFile(`${baseUrl}/audio.mp3`, tmpDir, 'test');

    expect(path.dirname(result)).toBe(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('rejects when server returns 404', async () => {
    const { baseUrl, close } = await startServer((_req, res) => {
      res.writeHead(404);
      res.end('Not Found');
    });
    closeServer = close;

    const { downloadFile } = await import('../../src/utils/download.js');
    await expect(
      downloadFile(`${baseUrl}/missing.mp3`, tmpDir, 'missing')
    ).rejects.toThrow(/HTTP 404/);
  });

  it('rejects when server returns 500', async () => {
    const { baseUrl, close } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('Error');
    });
    closeServer = close;

    const { downloadFile } = await import('../../src/utils/download.js');
    await expect(
      downloadFile(`${baseUrl}/error.mp3`, tmpDir, 'error')
    ).rejects.toThrow(/HTTP 500/);
  });

  // -------------------------------------------------------------------------
  // Redirect handling
  // -------------------------------------------------------------------------

  it('follows a 301 redirect and downloads the final resource', async () => {
    // Use a ref object so the handler can self-reference the server URL
    const ref = { baseUrl: '' };

    const { baseUrl, close } = await startServer((req, res) => {
      if (req.url === '/original.mp3') {
        res.writeHead(301, { location: `${ref.baseUrl}/final.mp3` });
        res.end();
      } else {
        res.writeHead(200);
        res.end('redirected audio');
      }
    });
    closeServer = close;
    ref.baseUrl = baseUrl; // set after server is up

    const { downloadFile } = await import('../../src/utils/download.js');
    const result = await downloadFile(`${baseUrl}/original.mp3`, tmpDir, 'redirect-test');

    const content = await readFile(result, 'utf8');
    expect(content).toBe('redirected audio');
  });
});
