// Rebuild the tab PNGs from their SVG sources. Requires librsvg's rsvg-convert.
// Run: node scripts/renderPracticeRecordIcons.js
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = path.join(__dirname, '..', 'miniprogram', 'images', 'icons');
for (const name of ['practice-records', 'practice-records-active']) {
  const result = spawnSync('rsvg-convert', [
    '--width', '72', '--height', '72',
    '--output', path.join(directory, `${name}.png`),
    path.join(directory, `${name}.svg`)
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'SVG rasterization failed');
  console.log(`Created ${name}.png at 72×72`);
}
