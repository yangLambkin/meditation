const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const componentPath = path.join(__dirname, '../miniprogram/components/time-picker/time-picker.js');

// Exercise the component's event contract; native wheel physics and visual
// continuity still need the developer tools or a phone.
function createPicker(value = '06:57', { deferRenderCallbacks = false } = {}) {
  let definition;
  let time = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const renderCallbacks = [];
  const events = [];
  const writes = [];
  vm.runInNewContext(fs.readFileSync(componentPath, 'utf8'), {
    Component(component) { definition = component; },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  }, { filename: componentPath });

  const picker = {
    ...definition.methods,
    properties: { value },
    data: { ...structuredClone(definition.data), value },
    setData(update, callback) {
      writes.push(structuredClone(update));
      Object.assign(this.data, update);
      if (callback) {
        if (deferRenderCallbacks) renderCallbacks.push(callback);
        else callback();
      }
    },
    triggerEvent(name, detail) { events.push({ name, detail: detail && structuredClone(detail) }); }
  };
  definition.lifetimes.attached.call(picker);

  function advance(milliseconds = 100) {
    const end = time + milliseconds;
    for (;;) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry;
      time = timer.at;
      timers.delete(id);
      timer.callback();
    }
    time = end;
  }

  function change(hour, minuteIndex) {
    picker.onChange({ detail: { value: [hour, minuteIndex] } });
  }

  function select(hour, minuteIndex, order = 'change-first') {
    picker.onPickStart();
    if (order === 'change-first') {
      change(hour, minuteIndex);
      picker.onPickEnd();
    } else {
      picker.onPickEnd();
      change(hour, minuteIndex);
    }
    advance();
  }

  return {
    picker, events, timers, writes, renderCallbacks, advance, change, select,
    detach() { definition.lifetimes.detached.call(picker); },
    updateValue(next) {
      picker.properties.value = next;
      picker.data.value = next;
    }
  };
}

function confirmedValue(app) {
  app.picker.onConfirm();
  assert.equal(app.events.at(-1)?.name, 'confirm');
  return app.events.at(-1).detail.value;
}

test('time picker opens at the selected time with unique repeated minute rows', () => {
  const app = createPicker('23:59');
  assert.deepEqual(Array.from(app.picker.data.pickerValue), [23, 179]);
  assert.equal(app.picker.data.hours.length, 24);
  assert.equal(app.picker.data.hours[0], '00');
  assert.equal(app.picker.data.hours[23], '23');
  const { minutes } = app.picker.data;
  assert.equal(new Set(minutes.map(minute => minute.id)).size, minutes.length);
  assert.equal(minutes[179].label, '59');
  assert.equal(minutes[180].label, '00');
  assert.equal(minutes[119].label, '59');
  assert.equal(minutes[120].label, '00');
  assert.equal(confirmedValue(app), '23:59');
});

test('minutes wrap 59 → 00 and 00 → 59 without carrying or borrowing the hour', () => {
  for (const hour of ['00', '06', '23']) {
    const forward = createPicker(`${hour}:59`);
    forward.select(Number(hour), forward.picker.data.pickerValue[1] + 1);
    assert.equal(confirmedValue(forward), `${hour}:00`);

    const backward = createPicker(`${hour}:00`);
    backward.select(Number(hour), backward.picker.data.pickerValue[1] - 1);
    assert.equal(confirmedValue(backward), `${hour}:59`);
  }
});

test('repeated full turns in either direction keep minutes available after recentering', () => {
  for (const direction of [-1, 1]) {
    const app = createPicker('23:00');
    for (let step = 1; step <= 480; step++) {
      const index = app.picker.data.pickerValue[1] + direction;
      app.select(23, index);
      const selected = app.picker.data.pickerValue[1];
      const minute = ((step * direction) % 60 + 60) % 60;
      assert.equal(confirmedValue(app), `23:${String(minute).padStart(2, '0')}`);
      assert.ok(selected >= 60 && selected < 240, 'settled wheel retains buffer on both sides');
    }
  }
});

for (const order of ['change-first', 'end-first']) {
  test(`confirm waits for the last wheel event (${order})`, () => {
    const app = createPicker('06:59');
    app.picker.onPickStart();
    app.picker.onConfirm();
    assert.equal(app.events.length, 0, 'a moving wheel cannot submit the previous minute');
    if (order === 'change-first') {
      app.change(6, 180);
      app.advance(100);
      app.picker.onConfirm();
      assert.equal(app.events.length, 0, 'change alone cannot finish a gesture');
      app.picker.onPickEnd();
    } else {
      app.picker.onPickEnd();
      app.advance(20);
      app.change(6, 180);
    }
    app.advance(30);
    app.picker.onConfirm();
    assert.equal(app.events.length, 0, 'confirmation stays locked until the final event settles');
    app.advance(30);
    assert.equal(app.picker.data.busy, false);
    assert.equal(confirmedValue(app), '06:00');
  });
}

test('an unchanged gesture unlocks after pickend without requiring a change event', () => {
  const app = createPicker();
  app.picker.onPickStart();
  app.picker.onPickEnd();
  app.advance();
  assert.equal(confirmedValue(app), '06:57');
});

test('a new gesture cancels the previous settle and blocks its pending render callback', () => {
  const app = createPicker('06:59', { deferRenderCallbacks: true });
  app.select(6, 180);
  assert.equal(app.renderCallbacks.length, 1);
  app.picker.onPickStart();
  app.renderCallbacks.shift()();
  app.picker.onConfirm();
  assert.equal(app.events.length, 0);
  assert.equal(app.picker.data.busy, true);
  app.change(7, 181);
  app.picker.onPickEnd();
  app.advance();
  app.renderCallbacks.shift()();
  assert.equal(confirmedValue(app), '07:01');
});

test('a new gesture cancels an older settle timer before it can unlock confirmation', () => {
  const app = createPicker('06:59');
  app.picker.onPickStart();
  app.change(6, 180);
  app.picker.onPickEnd();
  app.advance(20);
  app.picker.onPickStart();
  app.advance(200);
  app.picker.onConfirm();
  assert.equal(app.events.length, 0);
  app.change(6, 181);
  app.picker.onPickEnd();
  app.advance();
  assert.equal(confirmedValue(app), '06:01');
});

test('programmatic recenter change echoes do not alter the draft or create a settle loop', () => {
  for (const minuteIndex of [0, 59, 240, 299]) {
    const app = createPicker();
    app.select(6, minuteIndex);
    const target = Array.from(app.picker.data.pickerValue);
    assert.deepEqual(target, [6, 120 + minuteIndex % 60]);
    const writeCount = app.writes.length;
    app.change(...target);
    assert.equal(app.picker.data.busy, false);
    assert.equal(app.timers.size, 0);
    assert.equal(app.writes.length, writeCount);
    assert.equal(confirmedValue(app), `06:${String(minuteIndex % 60).padStart(2, '0')}`);
  }
});

test('parent clock updates cannot overwrite an already open time draft', () => {
  const app = createPicker('06:59');
  app.select(6, 180);
  app.updateValue('07:01');
  assert.equal(confirmedValue(app), '06:00');
});

test('cancel discards the draft and rejects delayed events until the component is removed', () => {
  const app = createPicker('06:57');
  app.picker.onPickStart();
  app.change(6, 180);
  app.picker.onPickEnd();
  app.picker.onCancel();
  assert.deepEqual(app.events.map(event => event.name), ['cancel']);
  assert.equal(app.timers.size, 0);
  app.advance();
  app.picker.onPickStart();
  app.change(8, 190);
  app.picker.onPickEnd();
  app.advance();
  app.picker.onConfirm();
  assert.deepEqual(app.events.map(event => event.name), ['cancel']);
  app.detach();

  const reopened = createPicker('06:57');
  assert.equal(confirmedValue(reopened), '06:57');
});

test('detached clears scheduled work and invalidates outstanding render callbacks', () => {
  const app = createPicker();
  app.picker.onPickEnd();
  assert.equal(app.timers.size, 1);
  app.detach();
  assert.equal(app.timers.size, 0);
  const writeCount = app.writes.length;
  app.advance();
  app.picker.onConfirm();
  assert.equal(app.events.length, 0);
  assert.equal(app.writes.length, writeCount);

  const pendingRender = createPicker('06:57', { deferRenderCallbacks: true });
  pendingRender.select(6, 240);
  assert.equal(pendingRender.renderCallbacks.length, 1);
  pendingRender.detach();
  const detachedWrites = pendingRender.writes.length;
  pendingRender.renderCallbacks.shift()();
  assert.equal(pendingRender.writes.length, detachedWrites);
  pendingRender.picker.onConfirm();
  assert.equal(pendingRender.events.length, 0);
});

test('invalid wheel events cannot commit an out-of-range time', () => {
  for (const value of [null, [], [0], [24, 120], [-1, 120], [6, -1], [6, 300], [6, 1.5], ['6', 120]]) {
    const app = createPicker('06:57');
    app.picker.onChange({ detail: { value } });
    assert.equal(confirmedValue(app), '06:57');
  }
  for (const value of ['', '24:00', '00:60', '6:57', 'invalid']) {
    assert.equal(confirmedValue(createPicker(value)), '00:00');
  }
});
