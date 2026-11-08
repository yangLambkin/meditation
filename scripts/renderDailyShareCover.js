// Build the bundled 5:4 cover and optional previews from the same draw function
// used by WeChat. Requires librsvg's rsvg-convert; no project dependencies.
// node scripts/renderDailyShareCover.js [absolute-preview-directory]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { drawDailyShareCover, WIDTH, HEIGHT } = require('../miniprogram/utils/dailyShareCover');

const directory = path.join(__dirname, '..', 'miniprogram', 'images');
const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
}[character]));

// Record the small subset of Canvas2d used by the cover into SVG. The preview
// uses system Chinese fonts; approximate glyph widths keep wrapping close to
// the native Canvas, whose exact font metrics can vary by WeChat device.
function renderSvg(snapshot) {
  const elements = [];
  let currentPath = '';
  const ctx = {
    font: '16px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    textAlign: 'left', textBaseline: 'top',
    measureText(value) {
      const size = Number.parseFloat(this.font);
      return { width: Array.from(value).reduce((sum, character) =>
        sum + size * (/^[\x00-\x7f]$/.test(character) ? 0.55 : 1), 0) };
    },
    beginPath() { currentPath = ''; },
    moveTo(x, y) { currentPath += `M${x} ${y}`; },
    lineTo(x, y) { currentPath += `L${x} ${y}`; },
    quadraticCurveTo(cx, cy, x, y) { currentPath += `Q${cx} ${cy} ${x} ${y}`; },
    closePath() { currentPath += 'Z'; },
    fill() { elements.push(`<path d="${currentPath}" fill="${escape(this.fillStyle)}"/>`); },
    stroke() { elements.push(`<path d="${currentPath}" fill="none" stroke="${escape(this.strokeStyle)}" stroke-width="${this.lineWidth}"/>`); },
    fillRect(x, y, width, height) {
      elements.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escape(this.fillStyle)}"/>`);
    },
    fillText(value, x, y) {
      const size = Number.parseFloat(this.font);
      // librsvg ignores Canvas-style top baselines; use an alphabetic baseline.
      elements.push(`<text x="${x}" y="${y + size * 0.88}" font-size="${size}" fill="${escape(this.fillStyle)}">${escape(value)}</text>`);
    }
  };
  drawDailyShareCover(ctx, snapshot);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">静坐觉察 · 静心卡</title>
  <desc id="description">一刻静坐，一份安静。</desc>
  <g font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif">
    ${elements.join('\n    ')}
  </g>
</svg>
`;
}

function writeCover(targetDirectory, name, snapshot) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  const svg = path.join(targetDirectory, `${name}.svg`);
  const png = path.join(targetDirectory, `${name}.png`);
  fs.writeFileSync(svg, renderSvg(snapshot));
  const result = spawnSync('rsvg-convert', ['--width', String(WIDTH), '--height', String(HEIGHT), '--output', png, svg], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Daily share cover rasterization failed');
  console.log(png);
}

writeCover(directory, 'daily-share', { quote: '把心安放在当下。', session: null });
if (process.argv[2]) {
  const previewDirectory = path.resolve(process.argv[2]);
  const session = { name: '小涟', minutes: 30, endedAt: 1793968200000, dateLabel: '2026.11.06', timeLabel: '20:30' };
  writeCover(previewDirectory, 'session-1-minute', {
    quote: '造成我们痛苦的，不是事情本身，而是对事情的反应。',
    session: { ...session, name: '瑞璞', minutes: 1, endedAt: 1794109020000, dateLabel: '2026.11.08', timeLabel: '11:37' }
  });
  writeCover(previewDirectory, 'session-30-minutes', { quote: '以不紧不慢的心，安住每一个当下。', session });
  writeCover(previewDirectory, 'session-long-name-1440-minutes', {
    quote: '安住当下，温柔觉察每一次呼吸。'.repeat(6),
    session: { ...session, name: '温柔安住于每个当下的静坐同学🙂'.repeat(3), minutes: 1440 }
  });
  writeCover(previewDirectory, 'legacy-neutral', { quote: '把心安放在当下。', session: null });
}
