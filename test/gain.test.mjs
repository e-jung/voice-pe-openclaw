import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceGain } from '../src/audio.mjs';

function samples(values) {
  const pcm = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => pcm.writeInt16LE(value, i * 2));
  return pcm;
}
test('voice trim gives 4 dB linear gain below limiter knee, without mutating input', () => {
  const values = [0, 1, -1, 8, -8, 1000, -1000, 14000, -14000];
  const input = samples(values), before = Buffer.from(input), output = voiceGain(input, 4);
  assert.deepEqual(input, before);
  values.forEach((value, i) => assert.equal(output.readInt16LE(i * 2), Math.round(value * 10 ** .2)));
  assert.equal(voiceGain(input, 0), input);
  assert.throws(() => voiceGain(input, NaN)); assert.throws(() => voiceGain(input, 13));
  assert.throws(() => voiceGain(Buffer.alloc(1), 4));
});
test('every PCM16 value stays bounded and monotonic under maximum trim', () => {
  const input = samples(Array.from({ length: 65536 }, (_, i) => i - 32768));
  const output = voiceGain(input, 12);
  let last = -32768;
  for (let i = 0; i < output.length; i += 2) {
    const value = output.readInt16LE(i);
    assert(value >= last); assert(Math.abs(value) <= Math.ceil(.98 * 32768));
    last = value;
  }
  assert.equal(output.readInt16LE(32768 * 2), 0);
  assert.equal(output.readInt16LE(32767 * 2), -output.readInt16LE(32769 * 2));
});
test('voice gain is independent of transport chunk boundaries and preserves length', () => {
  const input = samples(Array.from({ length: 1000 }, (_, i) => Math.round(32000 * Math.sin(i / 9))));
  const output = voiceGain(input, 4);
  const chunked = Buffer.concat([voiceGain(input.subarray(0, 2), 4),
    voiceGain(input.subarray(2, 958), 4), voiceGain(input.subarray(958), 4)]);
  assert.equal(output.length, input.length); assert.deepEqual(output, chunked);
});
