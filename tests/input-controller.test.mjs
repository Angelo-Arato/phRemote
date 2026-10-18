import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { InputController } from '../desktop/input-controller.mjs';

// This executable records the stdin contract only. It imports no input APIs and
// never loads the native helpers, so these tests cannot send keyboard/mouse input.
const FAKE_HELPER = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [log, mode] = process.argv.slice(2);
const previous = readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
const run = previous.filter(item => item.type === 'spawn').length + 1;
const record = item => appendFileSync(log, JSON.stringify({ run, ...item }) + '\\n');
record({ type: 'spawn', pid: process.pid });
const permission = !(mode === 'crash-recovery-denied' && run > 1);
const ready = () => process.stdout.write(JSON.stringify({ type: 'ready', supported: true, permission, status: permission ? 'ready' : 'permission-required' }) + '\\n');
if (mode === 'delayed-ready') setTimeout(ready, 200).unref();
else ready();
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
  const event = JSON.parse(line);
  record({ type: 'event', event });
  if (mode.startsWith('crash') && run === 1 && event.event === 'keyDown') {
    record({ type: 'crash' });
    process.exit(7);
  }
  if (mode === 'native-error' && event.event === 'keyDown') {
    process.stdout.write(JSON.stringify({ type: 'error', message: 'Fake delivery error.' }) + '\\n');
  }
  if (event.kind === 'control' && event.event === 'releaseAll') {
    process.stdout.write(JSON.stringify({ type: 'released' }) + '\\n');
  }
});
input.on('close', () => {
  record({ type: 'eof' });
  process.stdout.end(() => process.exit(0));
});
`;

async function fixture(t, mode = 'normal') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phremote-input-test-'));
  const script = path.join(directory, 'helper.mjs');
  const log = path.join(directory, 'events.jsonl');
  await writeFile(script, FAKE_HELPER);
  await writeFile(log, '');
  // Replace only the platform boundary: lifecycle, validation, pipe handling and
  // process creation stay in the production controller. No DISPLAY is required.
  class RecordingController extends InputController {
    async check() {
      await access(script);
      if (this.availabilityGate) await this.availabilityGate;
      return { supported: true, permission: null, status: 'not-started' };
    }
    _command() { return { executable: process.execPath, args: [script, log, mode] }; }
  }
  const controller = new RecordingController();
  t.after(async () => {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const records = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { controller, records };
}

async function waitFor(predicate, description) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('construction, availability checking and unapproved input do not start a helper', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t);
  const availability = await InputController.prototype.check.call(controller);
  assert.ok(availability.permission === null || availability.permission === false);
  assert.equal(controller.apply({ kind: 'input', event: 'keyDown', code: 'KeyA' }), false);
  await controller.stop();
  assert.deepEqual(await records(), []);
});

test('concurrent start requests share one input process', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t);
  const results = await Promise.all([controller.start(), controller.start(), controller.start()]);
  assert.ok(results.every(result => result.status === 'ready' && result.permission === true));
  await controller.stop();
  assert.equal((await records()).filter(record => record.type === 'spawn').length, 1);
});

test('revocation while start checks availability cancels process creation', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t);
  let allowAvailability;
  controller.availabilityGate = new Promise(resolve => { allowAvailability = resolve; });
  const starting = controller.start();
  await controller.stop();
  allowAvailability();
  assert.equal((await starting).status, 'stopped');
  assert.deepEqual(await records(), []);
});

test('revocation while a spawned helper is starting cannot restore input permission', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t, 'delayed-ready');
  const starting = controller.start();
  await waitFor(async () => (await records()).some(record => record.type === 'spawn'), 'the helper process to start');
  assert.equal(controller.apply({ kind: 'input', event: 'keyDown', code: 'KeyA' }), false);
  await controller.stop();
  await starting;
  assert.equal(controller.state.status, 'stopped');
  assert.equal(controller.state.permission, null);
  const log = await records();
  assert.equal(log.filter(record => record.type === 'spawn').length, 1);
  assert.ok(log.filter(record => record.type === 'event').every(record => record.event.kind === 'control'));
  assert.equal(log.at(-1).type, 'eof');
});

test('key/button releases and releaseAll reach EOF even when input is throttled', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t);
  assert.equal((await controller.start()).status, 'ready');
  assert.equal(controller.apply({ kind: 'input', event: 'keyDown', code: 'ControlLeft', modifiers: { ctrl: true } }), true);
  assert.equal(controller.apply({ kind: 'input', event: 'down', x: 0.5, y: 0.5, button: 0 }), true);
  let throttled = false;
  for (let count = 0; count < 1000; count += 1) {
    if (!controller.apply({ kind: 'input', event: 'keyDown', code: 'KeyA' })) { throttled = true; break; }
  }
  assert.equal(throttled, true, 'the flood must exhaust the non-release input budget');
  assert.equal(controller.apply({ kind: 'input', event: 'keyUp', code: 'ControlLeft' }), true);
  assert.equal(controller.apply({ kind: 'input', event: 'up', x: 0.5, y: 0.5, button: 0 }), true);
  await controller.stop();
  const log = await records();
  const events = log.filter(record => record.type === 'event').map(record => record.event);
  assert.ok(events.some(event => event.event === 'keyUp' && event.code === 'ControlLeft'));
  assert.ok(events.some(event => event.event === 'up' && event.button === 0));
  assert.deepEqual(events.at(-1), { kind: 'control', event: 'releaseAll' });
  assert.equal(log.at(-1).type, 'eof', 'stop must wait for the helper to consume EOF');
  assert.equal(controller.apply({ kind: 'input', event: 'keyDown', code: 'KeyA' }), false);
});

test('invalid remote payloads never cross the native process boundary', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t);
  await controller.start();
  for (const payload of [
    null,
    [],
    { kind: 'control', event: 'releaseAll' },
    { kind: 'input', event: 'move', x: NaN, y: 0 },
    { kind: 'input', event: 'move', x: 1.1, y: 0 },
    { kind: 'input', event: 'move', x: 0.5 },
    { kind: 'input', event: 'down', x: 0, y: 0, button: true },
    { kind: 'input', event: 'keyDown', code: '$(arbitrary command)' },
    { kind: 'input', event: 'keyDown', code: 'KeyA', modifiers: { ctrl: 'true' } },
    { kind: 'input', event: 'scroll', deltaY: Infinity },
    { kind: 'input', event: 'text', text: '\0' },
    { kind: 'input', event: 'text', text: 'x'.repeat(513) },
  ]) assert.equal(controller.apply(payload), false);
  await controller.stop();
  assert.deepEqual((await records()).filter(record => record.type === 'event').map(record => record.event), [{ kind: 'control', event: 'releaseAll' }]);
});

test('a helper delivery error requests immediate release before shutdown', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t, 'native-error');
  await controller.start();
  controller.apply({ kind: 'input', event: 'keyDown', code: 'ControlLeft', modifiers: { ctrl: true } });
  await waitFor(async () => (await records()).some(record => record.type === 'event' && record.event.kind === 'control'), 'release after native delivery error');
  await controller.stop();
  assert.equal((await records()).at(-1).type, 'eof');
});

test('a crashed helper gets one release-only recovery process without resuming control', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t, 'crash');
  await controller.start();
  controller.apply({ kind: 'input', event: 'keyDown', code: 'ControlLeft', modifiers: { ctrl: true } });
  // This release can be queued after the fake helper has already crashed. A
  // recovery must still release the press rather than assuming delivery.
  controller.apply({ kind: 'input', event: 'keyUp', code: 'ControlLeft' });
  await waitFor(async () => (await records()).some(record => record.run === 2 && record.type === 'eof'), 'release-only crash recovery');
  assert.equal(controller.apply({ kind: 'input', event: 'keyDown', code: 'KeyB' }), false);
  await controller.stop();
  const log = await records();
  assert.equal(log.filter(record => record.type === 'spawn').length, 2);
  const recovery = log.filter(record => record.run === 2 && record.type === 'event').map(record => record.event);
  assert.ok(recovery.some(event => event.event === 'keyUp' && event.code === 'ControlLeft'));
  assert.ok(recovery.every(event => ['keyUp', 'up', 'releaseAll'].includes(event.event)), 'recovery may only release input');
  assert.deepEqual(recovery.at(-1), { kind: 'control', event: 'releaseAll' });
});

test('denied recovery remains visible and never resumes control or retries indefinitely', { timeout: 10000 }, async (t) => {
  const { controller, records } = await fixture(t, 'crash-recovery-denied');
  await controller.start();
  controller.apply({ kind: 'input', event: 'keyDown', code: 'ControlLeft', modifiers: { ctrl: true } });
  await waitFor(async () => (await records()).some(record => record.run === 2 && record.type === 'eof'), 'permission-denied cleanup');
  const status = await controller.stop();
  assert.equal(status.status, 'helper-error');
  assert.equal(status.permission, false);
  assert.match(status.message, /release could not be confirmed/i);
  assert.equal(controller.apply({ kind: 'input', event: 'keyDown', code: 'KeyA' }), false);
  const log = await records();
  assert.equal(log.filter(record => record.type === 'spawn').length, 2);
  assert.equal(log.filter(record => record.run === 2 && record.type === 'event').length, 0);
});
