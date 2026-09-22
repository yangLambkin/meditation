const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const avatar = require('../miniprogram/utils/avatar.js');

test('avatar initials use trimmed Chinese names or uppercase Latin initials, with an empty-name fallback', () => {
  assert.equal(avatar.getAvatarInitial('  小林 '), '小');
  assert.equal(avatar.getAvatarInitial(' ripples'), 'R');
  assert.equal(avatar.getAvatarInitial('Alice'), 'A');
  assert.equal(avatar.getAvatarInitial('𠮷田'), '𠮷');
  for (const empty of ['', '  ', null, undefined]) assert.equal(avatar.getAvatarInitial(empty), '友');
});

test('persisted default images use initials while custom avatars remain available', () => {
  for (const source of ['/images/avatar.png', 'images/userLogin.png', '/images/avatar-1.png', '', null]) {
    assert.equal(avatar.getAvatarSource(source), '');
  }
  for (const source of ['cloud://custom.png', 'https://example.com/avatar.png', 'wxfile://avatar.png']) {
    assert.equal(avatar.getAvatarSource(source), source);
  }
});

test('avatar component recovers from broken images and updates initials when the nickname changes', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/nickname-avatar/nickname-avatar.js'), 'utf8'), {
    Component(value) { definition = value; },
    require: () => avatar
  });
  const component = { data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  definition.observers.nickname.call(component, '小林');
  definition.observers.src.call(component, '/images/avatar.png');
  assert.equal(component.data.imageSource, '');
  assert.equal(component.data.initial, '小');
  definition.observers.src.call(component, 'cloud://missing.png');
  definition.methods.onImageError.call(component);
  definition.observers.nickname.call(component, 'ripples');
  assert.equal(component.data.imageSource, '');
  assert.equal(component.data.initial, 'R');
  definition.observers.src.call(component, 'cloud://new-avatar.png');
  assert.equal(component.data.imageSource, 'cloud://new-avatar.png');
});
