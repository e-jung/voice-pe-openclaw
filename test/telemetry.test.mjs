import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry, sanitize, sourceFingerprint } from '../src/telemetry.mjs';
import { createStream } from 'rotating-file-stream';

function capture() {
  const lines = [];
  return { lines, stream: new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } }) };
}
test('strict telemetry allowlist excludes transcripts, PCM, credentials and arbitrary errors', () => {
  assert.deepEqual(sanitize({ role: 'user', final: 1, bytes: 960, transcript: 'PRIVATE', audioBase64: 'PRIVATE',
    token: 'PRIVATE', error: new Error('PRIVATE'), provider: 'PRIVATE', phase: 'replying', inputRttMaxMs: Infinity,
    code: 'PRIVATE secret', unknown: 100 }), { role: 'user', final: 1, bytes: 960, phase: 'replying' });
});
test('persistent timeline correlates calls across controls, provider events and snapshots', async () => {
  const out = capture(), disk = capture(); let time = 1000;
  const t = createTelemetry({ stdout: out.stream, fileStream: disk.stream, now: () => time, monotonic: () => time });
  const observe = t.connection();
  observe('device_control', { control: 'start' });
  observe('device_control', { control: 'wake' }); time += 50;
  observe('provider_event', { provider: 'transcript', role: 'user', final: 1, text: 'PRIVATE' });
  observe('snapshot', { lastPeak: 8 });
  observe('device_control', { control: 'wake' });
  await t.close();
  assert.deepEqual(out.lines, disk.lines);
  const rows = disk.lines.map(JSON.parse);
  assert.equal(rows[1].call, 0); assert.equal(rows[2].call, 1); assert.equal(rows[5].call, 2);
  assert.equal(rows[2].connectionId, rows[4].connectionId); assert.equal(rows[3].ms, 50);
  assert(!disk.lines.join('').includes('PRIVATE'));
});
test('blocked logging sinks cannot accumulate unlimited audio-loop memory', async () => {
  const blocked = new Writable({ write() {} });
  const t = createTelemetry({ stdout: blocked, maxQueuedBytes: 2048 });
  for (let i = 0; i < 10000; i++) t.emit('snapshot', { frames: i });
  assert(blocked.writableLength < 2600);
  blocked.destroy(); await t.close();
});
test('rotated host files retain bounded history and survive logger reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-pe-log-test-'));
  try {
    const stdout = capture();
    const file = createStream('events.jsonl', { path: dir, size: '1K', rotate: 2, mode: 0o600 });
    const t = createTelemetry({ stdout: stdout.stream, fileStream: file });
    for (let i = 0; i < 80; i++) { t.emit('snapshot', { frames: i }); await new Promise(r => setTimeout(r, 1)); }
    await t.close();
    const files = await readdir(dir);
    assert(files.includes('events.jsonl')); assert(files.length <= 3);
    for (const name of files) for (const line of (await readFile(join(dir, name), 'utf8')).trim().split('\n'))
      if (line) assert.equal(JSON.parse(line).schema, 1);
    const reopened = createTelemetry({ directory: dir, stdout: stdout.stream }); reopened.emit('listen', { port: 8080 });
    await reopened.close();
    assert((await readFile(join(dir, 'events.jsonl'), 'utf8')).includes('"event":"listen"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('running revision fingerprints every adapter module', async () => {
  const f = await sourceFingerprint();
  assert.match(f.revision, /^[a-f0-9]{16}$/);
  assert.equal(Object.keys(f.hashes).length, 4);
  assert(Object.values(f.hashes).every(h => /^[a-f0-9]{64}$/.test(h)));
});
