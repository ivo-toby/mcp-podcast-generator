import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';
import path from 'path';

/**
 * Download a file from an HTTPS/HTTP URL to a local destination path.
 */
export async function downloadFile(url: string, destDir: string, filename: string): Promise<string> {
  await mkdir(destDir, { recursive: true });

  const ext = path.extname(new URL(url).pathname) || '.mp3';
  const destPath = path.join(destDir, `${filename}${ext}`);

  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet;
    const file = createWriteStream(destPath);

    getter(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Handle redirect
        file.close();
        downloadFile(response.headers.location, destDir, filename)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
      file.on('error', (err) => {
        file.close();
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}
