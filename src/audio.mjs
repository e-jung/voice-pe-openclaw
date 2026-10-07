// Stateful linear interpolation: exact integer phase, no per-message reset.
// Suitable for the 16k -> 24k MVP, not a production band-limited resampler.
export class PcmResampler {
  constructor(inputRate = 16000, outputRate = 24000) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.reset();
  }
  reset() { this.samples = []; this.base = 0; this.next = 0; this.odd = null; }
  push(bytes) {
    let buf = Buffer.from(bytes);
    if (this.odd !== null) { buf = Buffer.concat([Buffer.from([this.odd]), buf]); this.odd = null; }
    if (buf.length % 2) { this.odd = buf[buf.length - 1]; buf = buf.subarray(0, -1); }
    for (let i = 0; i < buf.length; i += 2) this.samples.push(buf.readInt16LE(i));
    const out = [];
    while (true) {
      const index = Math.floor(this.next / this.outputRate);
      const fraction = this.next % this.outputRate;
      const local = index - this.base;
      if (local >= this.samples.length || (fraction && local + 1 >= this.samples.length)) break;
      const a = this.samples[local], b = this.samples[local + 1] ?? a;
      out.push(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction / this.outputRate))));
      this.next += this.inputRate;
    }
    const keepFrom = Math.floor(this.next / this.outputRate);
    const discard = Math.max(0, Math.min(this.samples.length, keepFrom - this.base));
    this.samples.splice(0, discard); this.base += discard;
    const result = Buffer.alloc(out.length * 2);
    out.forEach((sample, i) => result.writeInt16LE(sample, i * 2));
    return result;
  }
}

// GPT-Live emits continuous PCM (including exact and near-digital silence) rather than
// audioDone. Frame it independently of transport chunks and end a spoken burst
// after 800 ms of near-digital silence. A live probe measured a continuous
// amplitude-one tail; peak <=8 PCM16 units (~-72 dBFS) must not hold the mic
// closed or start a reply. This is output gating, not microphone VAD.
export class ContinuousOutputGate {
  constructor() { this.reset(); }
  reset() {
    this.partial = Buffer.alloc(0); this.speaking = false; this.quietFrames = 0;
    this.stats = { frames: 0, exactZero: 0, nearZero: 0, peakLe32: 0, peakLe128: 0, maxPeak: 0, lastPeak: 0, quietRunMax: 0 };
  }
  push(pcm) {
    if (pcm.length % 2) throw new Error('odd playback PCM length');
    this.partial = Buffer.concat([this.partial, pcm]);
    const frames = []; let ended = false;
    while (this.partial.length >= 960) {
      const frame = Buffer.from(this.partial.subarray(0, 960));
      this.partial = this.partial.subarray(960);
      this.stats.frames++;
      let peak = 0;
      for (let i = 0; i < frame.length; i += 2) peak = Math.max(peak, Math.abs(frame.readInt16LE(i)));
      const quiet = peak <= 8;
      this.stats.lastPeak = peak; this.stats.maxPeak = Math.max(this.stats.maxPeak, peak);
      if (peak === 0) this.stats.exactZero++;
      else if (peak <= 8) this.stats.nearZero++;
      if (peak <= 32) this.stats.peakLe32++;
      if (peak <= 128) this.stats.peakLe128++;
      if (!quiet) { this.speaking = true; this.quietFrames = 0; ended = false; }
      if (!this.speaking) continue;
      frames.push(frame);
      if (quiet) {
        this.quietFrames++;
        this.stats.quietRunMax = Math.max(this.stats.quietRunMax, this.quietFrames);
        if (this.quietFrames >= 40) {
          this.speaking = false; this.quietFrames = 0; ended = true;
        }
      }
    }
    return { frames, ended };
  }
}

// Voice-only trim, AFTER output gating. Stateless soft-knee peak protection:
// no lookahead, chunk-dependent gain changes, AGC, or extra playback latency.
// Below 80% full scale the gain is exactly linear; louder peaks approach 98%
// smoothly rather than overflowing PCM16 or hitting a hard clipping plateau.
export function voiceGain(pcm, gainDb = 0) {
  if (!Number.isFinite(gainDb) || gainDb < 0 || gainDb > 12) throw new Error('voice gain must be 0..12 dB');
  if (pcm.length % 2) throw new Error('odd playback PCM length');
  if (gainDb === 0) return pcm;
  const gain = 10 ** (gainDb / 20), knee = .8, headroom = .18;
  const output = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    let level = Math.abs(sample) * gain / 32768;
    if (level > knee) level = knee + headroom * (1 - Math.exp(-(level - knee) / headroom));
    output.writeInt16LE(Math.sign(sample) * Math.round(level * 32768), i);
  }
  return output;
}

export class PlaybackQueue {
  constructor({ maxBytes = 48000, frameBytes = 960 } = {}) {
    this.maxBytes = maxBytes; this.frameBytes = frameBytes;
    this.generation = 0; this.bytes = 0; this.frames = [];
  }
  clear() { this.generation++; this.bytes = 0; this.frames = []; }
  push(pcm, generation = this.generation) {
    if (generation !== this.generation) return false;
    if (pcm.length % 2) throw new Error('odd playback PCM length');
    if (this.bytes + pcm.length > this.maxBytes) throw new Error('playback overload');
    for (let offset = 0; offset < pcm.length; offset += this.frameBytes) {
      const data = Buffer.from(pcm.subarray(offset, offset + this.frameBytes));
      this.frames.push({ data, generation }); this.bytes += data.length;
    }
    return true;
  }
  shift() {
    const frame = this.frames.shift();
    if (!frame) return null;
    this.bytes -= frame.data.length;
    return frame.generation === this.generation ? frame.data : null;
  }
}
