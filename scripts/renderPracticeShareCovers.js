// Rebuild bundled WeChat covers from SVG. Requires librsvg's rsvg-convert.
// Run: node scripts/renderPracticeShareCovers.js
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = path.join(__dirname, '..', 'miniprogram', 'images');
// Friend cards use 5:4; timeline thumbnails use 1:1 with their own composition.
for (const [name, width, height] of [
  ['practice-share', 500, 400],
  ['practice-share-timeline', 400, 400]
]) {
  const result = spawnSync('rsvg-convert', [
    '--width', String(width), '--height', String(height),
    '--output', path.join(directory, `${name}.png`),
    path.join(directory, `${name}.svg`)
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'SVG rasterization failed');
  console.log(`Created ${name}.png at ${width}×${height}`);
}
