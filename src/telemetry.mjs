import { createStream } from 'rotating-file-stream';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Strict field allowlist: never serialize arbitrary provider/device objects,
// transcripts, PCM, URLs, errors, credentials or session context.
const enums = {
  control: ['start', 'wake', 'interrupt', 'flush', 'cleared'],
  phase: ['idle', 'listening', 'thinking', 'replying'],
  provider: ['ready', 'clear', 'audioDone', 'transcript', 'mark', 'error', 'close'],
  role: ['user', 'assistant'],
  action: ['created', 'closed', 'create_requested', 'stop_requested', 'started', 'completed', 'flush_ignored'],
};
const numeric = new Set(['epoch', 'seq', 'final', 'bytes', 'ready', 'active', 'clearPending', 'inputBytes', 'outputBytes',
  'inputQueued', 'playbackQueued', 'inflight', 'speaking', 'quietFrames', 'inputQueueMax', 'inputRttMaxMs',
  'tickGapMaxMs', 'playbackQueueMax', 'frames', 'exactZero', 'nearZero', 'peakLe32', 'peakLe128', 'maxPeak',
  'lastPeak', 'quietRunMax', 'dropped', 'port', 'connected', 'probe', 'inputPendingMaxMs']);
const events = new Set(['startup', 'listen', 'connection', 'disconnect', 'gateway_ready', 'device_control',
  'phase', 'provider_event', 'session', 'snapshot', 'failure', 'shutdown', 'log_sink_error', 'work']);
export function sanitize(fields = {}) {
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numeric.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (enums[key]?.includes(value)) result[key] = value;
    else if (key === 'code' && typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)) result[key] = value;
  }
  return result;
}
export async function sourceFingerprint() {
  const hashes = {};
  for (const file of ['server.mjs', 'bridge.mjs', 'audio.mjs', 'telemetry.mjs'])
    hashes[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
  return { hashes, revision: createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0, 16) };
}
export function createTelemetry({ directory, stdout = process.stdout, fileStream, maxQueuedBytes = 65536,
  fingerprint, now = Date.now, monotonic = () => performance.now() } = {}) {
  const bootId = randomUUID(), started = monotonic();
  let sequence = 0, dropped = 0;
  const file = fileStream ?? (directory ? createStream('events.jsonl', {
    path: directory, size: '5M', rotate: 4, mode: 0o600, compress: false,
  }) : null);
  let fileFailed = false;
  file?.on('error', () => { fileFailed = true; emit('log_sink_error', { code: 'file-log-unavailable' }); });
  function emit(event, fields = {}, context = {}) {
    if (!events.has(event)) return;
    const row = { schema: 1, ts: new Date(now()).toISOString(), ms: Math.round(monotonic() - started),
      bootId, sequence: ++sequence, revision: fingerprint?.revision, event, ...sanitize(fields) };
    if (event === 'startup' && fingerprint?.hashes) row.hashes = fingerprint.hashes;
    if (context.connectionId && /^[0-9a-f-]{36}$/.test(context.connectionId)) row.connectionId = context.connectionId;
    if (Number.isSafeInteger(context.call) && context.call >= 0) row.call = context.call;
    if (dropped) row.dropped = dropped;
    const line = JSON.stringify(row) + '\n';
    let written = false;
    for (const sink of [stdout, fileFailed ? null : file]) {
      if (!sink || sink.destroyed || sink.writableLength > maxQueuedBytes) continue;
      try { sink.write(line); written = true; } catch { /* Logging cannot break audio. */ }
    }
    dropped = written ? 0 : dropped + 1;
  }
  function connection() {
    const connectionId = randomUUID(); let call = 0;
    return (event, fields = {}) => {
      if (event === 'device_control' && fields.control === 'wake') call++;
      emit(event, fields, { connectionId, call });
    };
  }
  emit('startup', {});
  return { emit, connection, file,
    close: () => new Promise(resolve => { if (!file || file.destroyed) resolve(); else file.end(resolve); }) };
}
