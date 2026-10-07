import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PcmResampler, PlaybackQueue } from '../src/audio.mjs';

// Optional import includes SDK startup footprint, never connects/authenticates.
const startup = performance.now();
if (process.env.OPENCLAW_GATEWAY_SDK_FILE)
  await import(pathToFileURL(process.env.OPENCLAW_GATEWAY_SDK_FILE).href);
const sdkImportMs = performance.now() - startup;
const frame = Buffer.alloc(640);
for (let n = 0; n < 320; n++) frame.writeInt16LE(Math.round(16000 * Math.sin(n / 10)), n * 2);
const resampler = new PcmResampler(), playback = new PlaybackQueue();
const frames = 3000, start = performance.now(), cpu = process.cpuUsage();
let outputBytes = 0, checksum = 0;
for (let i = 0; i < frames; i++) {
  const pcm = resampler.push(frame); playback.push(pcm); outputBytes += pcm.length;
  for (let next; (next = playback.shift());) checksum += next.readInt16LE(0);
}
const usage = process.cpuUsage(cpu);
process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  audioSeconds: frames * .02, wallMs: performance.now() - start,
  cpuMs: (usage.user + usage.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
  rssMiB: process.memoryUsage().rss / 1048576, sdkImported: !!process.env.OPENCLAW_GATEWAY_SDK_FILE,
  sdkImportMs, outputBytes, checksum,
  limitations: 'Synthetic in-process audio only; excludes sockets, TLS, provider and hardware. Not NAS measurement.' }, null, 2) + '\n');
