const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/daily/daily1.wxml'), 'utf8');

function attributes(tag) {
  const result = Object.create(null);
  const content = tag.replace(/^<[\w:-]+/, '').replace(/\/?\s*>$/, '');
  for (const match of content.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
    result[match[1]] = match[2] ?? match[3] ?? '';
  }
  return result;
}

function declarations(style = '') {
  const result = Object.create(null);
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const name = declaration.slice(0, separator).trim().toLowerCase();
    result[name] = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim().toLowerCase();
  }
  return result;
}

function pixels(value, label) {
  assert.match(value || '', /^-?\d+(?:\.\d+)?px$/, `${label} must have a concrete pixel size`);
  return Number.parseFloat(value);
}

function canvases() {
  const result = [];
  const ancestors = [];
  // Quoted attribute values may contain angle brackets inside WXML expressions.
  const tokens = source.matchAll(/<!--[\s\S]*?-->|<\/?[\w:-]+\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>/g);
  for (const [token] of tokens) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      ancestors.pop();
      continue;
    }
    const name = /^<([\w:-]+)/.exec(token)[1];
    const node = { name, attributes: attributes(token) };
    if (name === 'canvas') result.push({ ...node, ancestors: [...ancestors] });
    if (!token.endsWith('/>')) ancestors.push(node);
  }
  return result;
}

for (const id of ['dailyCanvas', 'dailyShareCanvas']) {
  test(`${id} stays mounted and hides its own native layer outside the visible page`, () => {
    const matches = canvases().filter(node => node.attributes.id === id);
    assert.equal(matches.length, 1, `${id} must identify exactly one canvas`);
    const canvas = matches[0];
    assert.equal(canvas.attributes.type, '2d', `${id} must support native Canvas2D export`);

    for (const node of [...canvas.ancestors, canvas]) {
      for (const attribute of ['wx:if', 'wx:elif', 'wx:else', 'wx:for', 'hidden']) {
        assert.equal(Object.hasOwn(node.attributes, attribute), false,
          `${id} cannot depend on a conditional or hidden ${node.name}`);
      }
      const style = declarations(node.attributes.style);
      assert.notEqual(style.display, 'none', `${id} must retain a mounted drawing surface`);
      assert.notEqual(style.visibility, 'hidden', `${id} must retain a mounted drawing surface`);
    }

    // Native canvas layers can escape their parent's opacity or clipping. The
    // canvas itself must remain invisible and noninteractive without that host.
    const style = declarations(canvas.attributes.style);
    const width = pixels(style.width, `${id} width`);
    const height = pixels(style.height, `${id} height`);
    const left = pixels(style.left, `${id} left`);
    assert.ok(width > 0 && height > 0, `${id} needs a nonzero export surface`);
    assert.equal(style.position, 'fixed', `${id} must not enter the page layout`);
    assert.ok(left + width <= 0, `${id} must sit entirely left of the visible viewport`);
    assert.equal(Number(style.opacity), 0, `${id} must hide its own native layer`);
    assert.equal(style['pointer-events'], 'none', `${id} must never cover page interactions`);
  });
}
