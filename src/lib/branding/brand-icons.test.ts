import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('wolfbot brand icons', () => {
  it('keeps the browser and application icons on the same SVG brand mark', async () => {
    const [publicMark, appIcon] = await Promise.all([
      fs.readFile(path.join(root, 'public', 'wolfbot-mark.svg'), 'utf8'),
      fs.readFile(path.join(root, 'src', 'app', 'icon.svg'), 'utf8'),
    ]);

    expect(appIcon).toBe(publicMark);
    for (const svg of [publicMark, appIcon]) {
      expect(svg).toContain('#F47D63');
      expect(svg).toContain('#C83F34');
      expect(svg).toContain('<title id="title">wolfbot</title>');
      expect(svg).toContain('viewBox="0 0 512 512"');
    }
  });

  it.each([
    ['public/favicon-16.png', 16],
    ['public/favicon-32.png', 32],
    ['public/favicon.png', 128],
    ['public/apple-touch-icon.png', 180],
    ['public/icons/wolfbot-192.png', 192],
    ['public/icons/wolfbot-512.png', 512],
    ['public/wolfbot-icon.png', 512],
  ])('provides %s at %ipx', async (relativePath, size) => {
    const metadata = await sharp(path.join(root, relativePath)).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(size);
    expect(metadata.height).toBe(size);
    expect(metadata.hasAlpha).toBe(true);
  });
});
