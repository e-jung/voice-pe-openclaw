import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmResampler, PlaybackQueue, ContinuousOutputGate } from '../src/audio.mjs';
import { VoiceBridge } from '../src/bridge.mjs';

const contract = { inputEncoding: 'pcm16', inputSampleRateHz: 24000, outputEncoding: 'pcm16', outputSampleRateHz: 24000 };
const settle = () => new Promise(resolve => setImmediate(resolve));
function pcm(count) {
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(16000 * Math.sin(i / 9)), i * 2);
  return data;
}
function fixture({ request, now, voiceGainDb = 0 } = {}) {
  const calls = [], texts = [], binary = [];
  let closed = false, counter = 0, clock = 0;
  const gateway = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.messages.subscribe') return { subscribed: true, key: params.key };
    if (request) return request(method, params);
    if (method === 'talk.session.create') return { sessionId: `relay-${++counter}`, audio: contract, expiresAt: 2000 };
    return { ok: true };
  } };
  const device = { sendText: text => texts.push(text), sendBinary: data => binary.push(Buffer.from(data)),
    close: () => { closed = true; }, bufferedAmount: () => 0 };
  const bridge = new VoiceBridge({ gateway, device, sessionKey: 'agent:main:voice-pe-test', voiceGainDb, now: now ?? (() => { clock += 20; return clock; }) });
  return { bridge, calls, texts, binary, get closed() { return closed; } };
}
async function wake(f) {
  await f.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  await f.bridge.control({ type: 'wake' });
  f.bridge.event({ type: 'ready', relaySessionId: f.bridge.sessionId });
}
function agent(f, runId, phase, extra = {}) {
  f.bridge.agentEvent({ sessionKey: f.bridge.sessionKey, runId, stream: 'lifecycle',
    data: { phase, ...extra } });
}
test('partial user speech holds a follow-up for minutes, survives stale expiry, and never commits', async () => {
  let time = 1000; const f = fixture({ now: () => time }); await wake(f);
  f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(480).toString('base64') });
  f.bridge.tick();
  for (let i=0;i<40;i++) {
    f.bridge.event({type:'audio',relaySessionId:f.bridge.sessionId,audioBase64:Buffer.alloc(960).toString('base64')});
    time+=20; f.bridge.tick();
  }
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'idle');
  time += 7000;
  const fragment = () => f.bridge.event({ type: 'transcript', role: 'user', text: 'recognized speech', final: false, relaySessionId: f.bridge.sessionId });
  fragment(); assert(f.bridge.speechPending); assert.equal(JSON.parse(f.texts.at(-1)).value, 'listening');
  time += 2000; await f.bridge.control({ type: 'flush' }); assert(f.bridge.active);
  for (let i = 0; i < 12; i++) { time += 20000; fragment(); f.bridge.tick(); assert(!f.closed); }
  assert(!f.calls.some(c => /commit|cancelOutput|close/.test(c.method)));
  f.bridge.event({ type: 'transcript', role: 'user', text: 'completed long utterance', final: true, relaySessionId: f.bridge.sessionId });
  assert(!f.bridge.speechPending); assert.equal(JSON.parse(f.texts.at(-1)).value, 'thinking');
  agent(f, 'talk-realtime-relay-consult-rant', 'start');
  await f.bridge.control({ type: 'flush' }); assert(f.bridge.active);
  agent(f, 'talk-realtime-relay-consult-rant', 'end');
  f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(480).toString('base64') });
  f.bridge.event({ type: 'audioDone', relaySessionId: f.bridge.sessionId }); f.bridge.tick();
  await f.bridge.control({ type: 'flush' }); assert(!f.bridge.active);
});
test('speech holding ignores empty, assistant, other-session, clear-pending and playback transcripts', async () => {
  const f=fixture(); await wake(f);
  const fragment = extra => f.bridge.event({type:'transcript', role:'user', text:'speech', final:false, relaySessionId:f.bridge.sessionId, ...extra});
  fragment({role:'assistant'}); fragment({text:'  '}); fragment({relaySessionId:'other'});
  assert(!f.bridge.speechPending);
  f.bridge.discardedTurns.add('retired'); fragment({talkEvent:{turnId:'retired'}}); assert(!f.bridge.speechPending);
  f.bridge.beginClear(); fragment({}); assert(!f.bridge.speechPending);
  await f.bridge.control({type:'cleared',seq:f.bridge.clearWait});
  f.bridge.event({type:'audio',relaySessionId:f.bridge.sessionId,audioBase64:pcm(960).toString('base64')});
  fragment({}); assert(!f.bridge.speechPending);
});
test('stop and fresh wake cancel speech holds, and stalled recognition is bounded', async () => {
  let time=1000; const f=fixture({now:()=>time}); await wake(f);
  const fragment = () => f.bridge.event({type:'transcript',role:'user',text:'speech',final:false,relaySessionId:f.bridge.sessionId});
  fragment(); await f.bridge.control({type:'interrupt'}); assert(!f.bridge.speechPending); assert(!f.bridge.active);
  await f.bridge.control({type:'cleared',seq:f.bridge.clearWait}); await f.bridge.control({type:'wake'});
  f.bridge.event({type:'ready',relaySessionId:f.bridge.sessionId}); fragment();
  const old=f.bridge.sessionId; await f.bridge.control({type:'wake'}); assert(!f.bridge.speechPending);
  f.bridge.event({type:'transcript',role:'user',text:'late stale speech',final:false,relaySessionId:old}); assert(!f.bridge.speechPending);
  await f.bridge.control({type:'cleared',seq:f.bridge.clearWait}); f.bridge.event({type:'ready',relaySessionId:f.bridge.sessionId});
  fragment(); time+=60001; f.bridge.tick(); assert(f.closed);
  assert(f.texts.some(t=>t.includes('user-speech-stalled')));
});
test('voice gain boosts device bytes without changing silence threshold or completion', async () => {
  let time = 1000;
  const f = fixture({ voiceGainDb: 4, now: () => time }); await wake(f);
  const quiet = Buffer.alloc(960); for (let i = 0; i < 960; i += 2) quiet.writeInt16LE(8, i);
  const emit = bytes => f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: bytes.toString('base64') });
  emit(quiet); assert.equal(f.bridge.playback.bytes, 0);
  const speech = Buffer.alloc(960); for (let i = 0; i < 960; i += 2) speech.writeInt16LE(1000, i);
  emit(speech); f.bridge.tick();
  assert.equal(f.binary[0].readInt16LE(0), 1585);
  for (let i = 0; i < 40; i++) { emit(quiet); time += 20; f.bridge.tick(); }
  assert.equal(f.bridge.outputGate.stats.maxPeak, 1000);
  assert(!f.bridge.outputGate.speaking);
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'idle');
});
test('delegated research survives acknowledgement, eight-second expiry and later final reply', async () => {
  let time = 1000;
  const f = fixture({ now: () => time }); await wake(f);
  agent(f, 'talk-realtime-relay-consult-slow', 'start');
  f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(480).toString('base64') });
  f.bridge.event({ type: 'audioDone', relaySessionId: f.bridge.sessionId }); f.bridge.tick();
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'thinking');
  time += 10000; await f.bridge.control({ type: 'flush' });
  assert(f.bridge.active); assert(!f.calls.some(c => c.method === 'talk.session.close'));
  agent(f, 'talk-realtime-relay-consult-slow', 'end');
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'thinking');
  time += 2000;
  f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(480).toString('base64') });
  f.bridge.event({ type: 'audioDone', relaySessionId: f.bridge.sessionId }); f.bridge.tick();
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'idle');
  await f.bridge.control({ type: 'flush' });
  assert(!f.bridge.active);
});
test('agent lifecycle is exact-session, bounded, and explicit stop still cancels research', async () => {
  let time = 1000;
  const f = fixture({ now: () => time }); await wake(f);
  f.bridge.agentEvent({sessionKey:'agent:main:other',runId:'talk-realtime-relay-consult-other',stream:'lifecycle',data:{phase:'start'}});
  assert.equal(f.bridge.agentRuns.size, 0);
  agent(f,'not-a-voice-run','start'); assert.equal(f.bridge.agentRuns.size,0);
  agent(f,'talk-realtime-relay-consult-one','end'); assert.equal(f.bridge.agentRuns.size,0);
  agent(f,'talk-realtime-relay-consult-one','start');
  await f.bridge.control({type:'interrupt'}); assert(!f.bridge.active);
  agent(f,'talk-realtime-relay-consult-one','end'); assert.equal(f.bridge.agentRuns.size,0);
  await f.bridge.control({type:'cleared',seq:f.bridge.clearWait});
  await f.bridge.control({type:'wake'}); f.bridge.event({type:'ready',relaySessionId:f.bridge.sessionId});
  agent(f,'talk-realtime-relay-consult-stalled','start'); time += 180001; f.bridge.tick();
  assert(f.closed); assert(f.texts.some(t=>t.includes('agent-work-timeout')));
});
test('silent completion cannot remain stuck forever and stale lifecycle cannot reopen a new wake', async () => {
  let time = 1000; const f = fixture({ now:()=>time }); await wake(f);
  f.bridge.agentEvent({sessionKey:f.bridge.sessionKey,runId:'talk-realtime-relay-consult-stale',stream:'lifecycle',data:{phase:'start',startedAt:999}});
  assert.equal(f.bridge.agentRuns.size,0);
  agent(f,'talk-realtime-relay-consult-done','start');
  agent(f,'talk-realtime-relay-consult-done','end');
  agent(f,'talk-realtime-relay-consult-done','start'); assert.equal(f.bridge.agentRuns.size,0);
  time += 30001; f.bridge.tick();
  assert(f.closed); assert(f.texts.some(t=>t.includes('agent-answer-timeout')));
});
test('overlapping lifecycle completion cannot release another accepted request', async () => {
  const f=fixture(); await wake(f);
  agent(f,'talk-realtime-relay-consult-old','start');
  agent(f,'talk-realtime-relay-consult-new','start');
  agent(f,'talk-realtime-relay-consult-old','end',{aborted:true});
  assert(!f.closed); assert.equal(f.bridge.agentRuns.size,1);
  await f.bridge.control({type:'flush'}); assert(f.bridge.active);
});
test('a progressing long final answer is not killed by the delivery-stall deadline', async () => {
  let time=1000; const f=fixture({now:()=>time}); await wake(f);
  agent(f,'talk-realtime-relay-consult-long-answer','start');
  agent(f,'talk-realtime-relay-consult-long-answer','end');
  for(let i=0;i<4;i++) {
    time+=20000;
    f.bridge.event({type:'audio',relaySessionId:f.bridge.sessionId,audioBase64:pcm(480).toString('base64')});
    f.bridge.tick(); assert(!f.closed);
  }
  f.bridge.event({type:'audioDone',relaySessionId:f.bridge.sessionId}); f.bridge.tick();
  assert.equal(JSON.parse(f.texts.at(-1)).value,'idle');
});
test('failed exact-session subscription never opens an unprotected voice call', async () => {
  const f=fixture(); f.bridge.gateway.request=async ()=>{throw new Error('unavailable');};
  await f.bridge.control({type:'start',capabilities:['clear-v1']});
  await f.bridge.control({type:'wake'});
  assert(f.closed); assert.equal(f.bridge.sessionId,null);
});

test('resampler output invariant across every chunk boundary including split PCM sample', () => {
  const input = pcm(4801), all = new PcmResampler().push(input);
  const r = new PcmResampler(), pieces = [];
  for (let offset = 0; offset < input.length;) {
    const size = Math.min((offset * 13 % 177) + 1, input.length - offset);
    pieces.push(r.push(input.subarray(offset, offset + size))); offset += size;
  }
  assert.deepEqual(Buffer.concat(pieces), all);
  assert.equal(all.length / 2, 7201);
});
test('linear interpolation preserves signed endpoints and reset discards old sample', () => {
  const input = Buffer.alloc(4); input.writeInt16LE(-30000, 0); input.writeInt16LE(30000, 2);
  const r = new PcmResampler(), out = r.push(input);
  assert.equal(out.readInt16LE(0), -30000); assert.equal(out.readInt16LE(2), 10000);
  r.reset(); const one = Buffer.alloc(2); one.writeInt16LE(1234);
  assert.equal(r.push(one).readInt16LE(0), 1234);
});
test('playback bounds and stale generation rejects before dequeue', () => {
  const q = new PlaybackQueue({ maxBytes: 1920 });
  const previous = q.generation; q.push(Buffer.alloc(1920));
  assert.throws(() => q.push(Buffer.alloc(2)), /overload/);
  q.clear(); assert.equal(q.shift(), null);
  assert.equal(q.push(Buffer.alloc(960), previous), false); assert.equal(q.bytes, 0);
});
test('legacy firmware rejected because disconnect does not prove speaker clear', async () => {
  const f = fixture(); await f.bridge.control({ type: 'start' });
  assert.equal(f.closed, true); assert.equal(f.calls.length, 0);
  assert.match(f.texts[0], /firmware-clear-v1-required/);
});
test('device controls use compact JSON and negotiated relay model/voice/session key', async () => {
  const f = fixture(); await wake(f);
  assert(f.texts.includes('{"type":"phase","value":"listening"}'));
  assert(!f.texts[0].includes(': ')); assert.equal(JSON.parse(f.texts[0]).trigger_capture, 0);
  const create = f.calls.find(c => c.method === 'talk.session.create').params;
  assert.equal(create.sessionKey, 'agent:main:voice-pe-test');
  assert.equal(create.model, 'gpt-live-1-codex'); assert.equal(create.voice, 'cove');
});
test('pre-ready audio bounded and not sent until genuine ready, then bounded frame batches', async () => {
  const f = fixture();
  await f.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  await f.bridge.control({ type: 'wake' });
  f.bridge.audio(pcm(2000)); assert.equal(f.calls.filter(c => c.method.includes('appendAudio')).length, 0);
  f.bridge.event({ type: 'ready', relaySessionId: f.bridge.sessionId });
  await settle();
  const appends = f.calls.filter(c => c.method.includes('appendAudio'));
  assert(appends.length > 0); assert(appends.every(c => {
    const bytes = Buffer.from(c.params.audioBase64, 'base64').length;
    return bytes >= 960 && bytes <= 11520 && bytes % 960 === 0;
  }));
  assert.equal(f.texts.filter(t => t === '{"type":"ack"}').length, 1);
});
test('provider-ready event arriving before create RPC completes is not lost', async () => {
  let resolveCreate;
  const f = fixture({ request: method => method === 'talk.session.create'
    ? new Promise(resolve => { resolveCreate = resolve; }) : Promise.resolve({ ok: true }) });
  await f.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  const creating = f.bridge.control({ type: 'wake' }); await settle();
  f.bridge.event({ type: 'ready', relaySessionId: 'early' });
  resolveCreate({ sessionId: 'early', audio: contract }); await creating;
  assert.equal(f.bridge.ready, true);
});
test('unsupported negotiated codec fails without forwarding microphone', async () => {
  const f = fixture({ request: async method => method === 'talk.session.create'
    ? { sessionId: 'bad', audio: { ...contract, inputEncoding: 'g711_ulaw' } } : { ok: true } });
  await wake(f); assert.equal(f.closed, true);
  assert(!f.calls.some(c => c.method === 'talk.session.appendAudio'));
});
test('audioDone only sends idle after paced adapter queue drain, never fabricates speaker ACK', async () => {
  const f = fixture(); await wake(f);
  const id = f.bridge.sessionId;
  f.bridge.event({ type: 'audio', relaySessionId: id, audioBase64: pcm(960).toString('base64') });
  f.bridge.event({ type: 'mark', relaySessionId: id, markName: 'm1' });
  f.bridge.event({ type: 'audioDone', relaySessionId: id });
  const before = f.texts.length; f.bridge.tick();
  assert.equal(f.binary.length, 1); assert(!f.texts.slice(before).includes('{"type":"phase","value":"idle"}'));
  f.bridge.tick(); assert.equal(f.binary.length, 2);
  assert.equal(f.texts.at(-1), '{"type":"phase","value":"idle"}');
  assert(!f.calls.some(c => c.method.includes('acknowledgeMark')));
});
test('clear drops queued and pending PCM until matching firmware clear acknowledgement', async () => {
  const f = fixture(); await wake(f); const id = f.bridge.sessionId;
  const audio = { type: 'audio', relaySessionId: id, audioBase64: pcm(480).toString('base64') };
  f.bridge.event(audio); f.bridge.event({ type: 'clear', relaySessionId: id });
  const seq = f.bridge.clearWait; f.bridge.event(audio); f.bridge.tick(); assert.equal(f.binary.length, 0);
  await f.bridge.control({ type: 'cleared', seq: seq - 1 }); assert.equal(f.bridge.clearWait, seq);
  await f.bridge.control({ type: 'cleared', seq }); assert.equal(f.bridge.clearWait, null);
  assert.equal(f.texts.at(-1), '{"type":"phase","value":"listening"}');
  f.bridge.event(audio); f.bridge.tick(); assert.equal(f.binary.length, 1);
});
test('physical interrupt uses non-barge-in cancellation and closes; re-wake preserves session key', async () => {
  const f = fixture(); await wake(f); const old = f.bridge.sessionId;
  await f.bridge.control({ type: 'interrupt' });
  assert(f.calls.some(c => c.method === 'talk.session.cancelOutput' && c.params.reason === 'device-stop'));
  assert(f.calls.some(c => c.method === 'talk.session.close'));
  await f.bridge.control({ type: 'cleared', seq: f.bridge.clearWait });
  await f.bridge.control({ type: 'wake' }); const current = f.bridge.sessionId;
  assert.notEqual(current, old);
  f.bridge.event({ type: 'audio', relaySessionId: old, audioBase64: pcm(480).toString('base64') });
  f.bridge.tick(); assert.equal(f.binary.length, 0);
  const creates = f.calls.filter(c => c.method === 'talk.session.create');
  assert(creates.every(c => c.params.sessionKey === creates[0].params.sessionKey));
});
test('follow-up flush discards partial PCM and closes, never commits audio', async () => {
  const f = fixture(); await wake(f); f.bridge.audio(pcm(40));
  await f.bridge.control({ type: 'flush' });
  assert.equal(f.bridge.partial.length, 0); assert.equal(f.bridge.sessionId, null);
  assert(f.calls.some(c => c.method === 'talk.session.close'));
  assert(!f.calls.some(c => /commit/i.test(c.method)));
});
test('bounded playback overload fails call instead of silently dropping old speech', async () => {
  const f = fixture(); await wake(f);
  f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(24480).toString('base64') });
  assert.equal(f.closed, true); assert.equal(f.bridge.playback.bytes, 0);
});
test('unacknowledged clear and never-ready provider both have finite deadlines', async () => {
  let time = 0;
  const f = fixture({ now: () => time }); await wake(f); f.bridge.beginClear();
  time = 2001; f.bridge.tick(); assert.equal(f.closed, true);
  time = 0; const g = fixture({ now: () => time });
  await g.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  await g.bridge.control({ type: 'wake' }); time = 15001; g.bridge.tick(); assert.equal(g.closed, true);
});

test('late old-turn audio/audioDone cannot resurrect after clear ACK; only one clear outstanding', async () => {
  const f = fixture(); await wake(f); const id = f.bridge.sessionId;
  const frame = turnId => ({ type: 'audio', relaySessionId: id,
    audioBase64: pcm(480).toString('base64'), talkEvent: { turnId } });
  f.bridge.event(frame('old')); f.bridge.beginClear(); const seq = f.bridge.clearWait;
  f.bridge.beginClear(); assert.equal(f.bridge.clearWait, seq);
  assert.equal(f.texts.filter(t => JSON.parse(t).type === 'clear').length, 1);
  await f.bridge.control({ type: 'cleared', seq });
  f.bridge.event(frame('old'));
  f.bridge.event({ type: 'audioDone', relaySessionId: id, talkEvent: { turnId: 'old' } });
  f.bridge.tick(); assert.equal(f.binary.length, 0); assert.equal(f.bridge.finishPending, false);
  f.bridge.event(frame('new')); f.bridge.tick(); assert.equal(f.binary.length, 1);
});
test('never-ready provider cannot accumulate unbounded microphone pre-roll', async () => {
  const f = fixture();
  await f.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  await f.bridge.control({ type: 'wake' });
  for (let i = 0; i < 16; i++) f.bridge.audio(pcm(16000));
  assert.equal(f.closed, true);
  assert.equal(f.bridge.inputBytes, 0);
  assert(!f.calls.some(c => c.method === 'talk.session.appendAudio'));
});

test('multi-second provider startup preserves first speech and drains before normal queue bound', async () => {
  const f = fixture();
  await f.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  await f.bridge.control({ type: 'wake' });
  const speech = pcm(16000);
  for (let i = 0; i < 3; i++) f.bridge.audio(speech);
  assert.equal(f.closed, false);
  assert(f.bridge.inputBytes > 24000);
  assert(!f.calls.some(c => c.method === 'talk.session.appendAudio'));
  f.bridge.event({ type: 'ready', relaySessionId: f.bridge.sessionId });
  // New microphone data during startup-drain still uses the startup budget.
  f.bridge.audio(pcm(320));
  assert.equal(f.closed, false);
  await settle();
  const sent = Buffer.concat(f.calls.filter(c => c.method === 'talk.session.appendAudio')
    .map(c => Buffer.from(c.params.audioBase64, 'base64')));
  const expected = new PcmResampler().push(Buffer.concat([speech, speech, speech, pcm(320)]));
  assert.deepEqual(sent, expected.subarray(0, Math.floor(expected.length / 960) * 960));
  assert.equal(f.bridge.startupBuffering, false);
});

test('ready but blocked transport retains small steady-state overload bound', async () => {
  const f = fixture({ request: async method => method === 'talk.session.create'
    ? { sessionId: 'blocked', audio: contract } : new Promise(() => {}) });
  await wake(f);
  f.bridge.audio(pcm(320));
  assert.equal(f.bridge.startupBuffering, false);
  f.bridge.audio(pcm(12000));
  assert.equal(f.closed, true);
});


test('continuous provider silence does not mark device replying; quiet tail returns to idle once', async () => {
  const f = fixture(); await wake(f); const id = f.bridge.sessionId;
  const emit = data => f.bridge.event({ type: 'audio', relaySessionId: id, audioBase64: data.toString('base64') });
  emit(Buffer.alloc(960)); f.bridge.tick(); assert.equal(f.binary.length, 0);
  emit(pcm(480)); f.bridge.tick();
  assert.equal(f.texts.filter(t => JSON.parse(t).value === 'replying').length, 1);
  for (let i = 0; i < 40; i++) { emit(Buffer.alloc(960)); f.bridge.tick(); }
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'idle');
  const textCount = f.texts.length, audioCount = f.binary.length;
  for (let i = 0; i < 50; i++) { emit(Buffer.alloc(960)); f.bridge.tick(); }
  assert.equal(f.texts.length, textCount); assert.equal(f.binary.length, audioCount);
  emit(pcm(480)); f.bridge.tick();
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'replying');
});

test('output gate handles split frames and keeps quiet pauses within a spoken burst', () => {
  const input = Buffer.concat([Buffer.alloc(960), pcm(480), Buffer.alloc(960 * 39), pcm(480)]);
  const gate = new ContinuousOutputGate(); const frames = [];
  for (let i = 0; i < input.length; i += 122) {
    const result = gate.push(input.subarray(i, i + 122));
    assert.equal(result.ended, false); frames.push(...result.frames);
  }
  assert.deepEqual(Buffer.concat(frames), input.subarray(960));
  gate.reset(); assert.equal(gate.speaking, false); assert.equal(gate.partial.length, 0);
});

test('hello and inactive clear ACK never latch firmware no-followup flag', async () => {
  const f = fixture();
  await f.bridge.control({ type: 'start', capabilities: ['clear-v1'] });
  f.bridge.beginClear();
  await f.bridge.control({ type: 'cleared', seq: f.bridge.clearWait });
  assert(f.texts.every(t => JSON.parse(t).followup !== false));
});

test('re-wake clear ACK during provider startup does not idle the fresh microphone', async () => {
  const f = fixture(); await wake(f);
  await f.bridge.control({ type: 'wake' });
  assert.equal(f.bridge.ready, false);
  const before = f.texts.length;
  await f.bridge.control({ type: 'cleared', seq: f.bridge.clearWait });
  assert.equal(f.texts.length, before);
  f.bridge.event({ type: 'ready', relaySessionId: f.bridge.sessionId });
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'listening');
});

test('ramping RPC latency to 600ms preserves sustained ordered microphone input', async () => {
  let time = 0;
  const pending = [], sent = [];
  const f = fixture({ request: async (method, params) => {
    if (method === 'talk.session.create') return { sessionId: 'slow', audio: contract };
    if (method === 'talk.session.appendAudio') {
      sent.push(Buffer.from(params.audioBase64, 'base64'));
      await new Promise(resolve => pending.push({ at: time + Math.min(600, 150 + Math.floor(time / 1000) * 50), resolve }));
    }
    return { ok: true };
  } });
  await wake(f);
  const pieces = [];
  for (let i = 0; i < 500; i++) {
    const data = pcm(320); pieces.push(data); f.bridge.audio(data);
    time += 20;
    for (let j = pending.length - 1; j >= 0; j--) {
      if (pending[j].at <= time) pending.splice(j, 1)[0].resolve();
    }
    await settle(); assert.equal(f.closed, false);
    assert(f.bridge.inflight <= 4);
  }
  while (pending.length) {
    time += 600; pending.splice(0).forEach(p => p.resolve()); await settle();
  }
  const expected = new PcmResampler().push(Buffer.concat(pieces));
  assert.deepEqual(Buffer.concat(sent), expected.subarray(0, Math.floor(expected.length / 960) * 960));
  assert(sent.every(data => data.length <= 11520));
});

test('late NAS timer wakeups sustain sixty seconds of output without growing playback latency', async () => {
  let time = 0;
  const f = fixture({ now: () => time }); await wake(f);
  const id = f.bridge.sessionId, frame = pcm(480);
  let nextTick = 0;
  for (let i = 0; i < 3000; i++) {
    time = i * 20;
    f.bridge.event({ type: 'audio', relaySessionId: id, audioBase64: frame.toString('base64') });
    // Regular 30ms wakeups plus periodic 150ms stalls, no invented extra PCM.
    if (time >= nextTick) {
      f.bridge.tick(); nextTick = time + (i % 100 === 0 ? 150 : 30);
    }
    assert.equal(f.closed, false); assert(f.bridge.playback.bytes < 960 * 20);
  }
  for (let i = 0; f.bridge.playback.bytes && i < 20; i++) { time += 20; f.bridge.tick(); }
  assert.deepEqual(Buffer.concat(f.binary), Buffer.concat(Array(3000).fill(frame)));
});

test('provider-confirmed user follow-up cancels expiry without reopening mic during playback', async () => {
  const f = fixture(); await wake(f); const id = f.bridge.sessionId;
  f.bridge.event({ type: 'transcript', role: 'assistant', final: true, relaySessionId: id });
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'listening');
  f.bridge.event({ type: 'transcript', role: 'user', final: true, relaySessionId: id });
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'thinking');
  f.bridge.event({ type: 'audio', relaySessionId: id, audioBase64: pcm(480).toString('base64') });
  f.bridge.tick();
  f.bridge.event({ type: 'transcript', role: 'user', final: true, relaySessionId: id });
  assert.equal(JSON.parse(f.texts.at(-1)).value, 'replying');
});

test('failure diagnostics contain only bounded numeric transport and output counters', async () => {
  const f = fixture(); await wake(f);
  f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(480).toString('base64') });
  f.bridge.tick(); f.bridge.fail('test-failure');
  const error = f.texts.map(JSON.parse).find(t => t.type === 'error');
  assert(Object.values(error.transport).every(Number.isFinite));
  assert(Object.values(error.output).every(Number.isFinite));
  assert(!JSON.stringify(error).includes('audioBase64'));
});

test('stuck continuous output emits bounded diagnostics without forcing idle or cutting audio', async () => {
  let time = 0;
  const f = fixture({ now: () => time }); await wake(f);
  for (let i = 0; i < 600; i++) {
    time = i * 20;
    f.bridge.event({ type: 'audio', relaySessionId: f.bridge.sessionId, audioBase64: pcm(480).toString('base64') });
    f.bridge.tick();
  }
  const controls = f.texts.map(JSON.parse);
  const diagnostics = controls.filter(t => t.type === 'diagnostics');
  assert.equal(diagnostics.length, 2);
  for (const d of diagnostics) {
    for (const group of [d.output, d.transport, d.flow]) assert(Object.values(group).every(Number.isFinite));
    assert(JSON.stringify(d).length < 1000);
    assert(d.flow.speaking === 1);
  }
  assert.equal(controls.filter(t => t.type === 'phase' && t.value === 'idle').length, 1);
  assert.deepEqual(Buffer.concat(f.binary), Buffer.concat(Array.from({ length: 600 }, () => pcm(480))));
});

test('output amplitude counters distinguish signed low-level noise from exact-zero completion', () => {
  const gate = new ContinuousOutputGate();
  const frame = sample => { const b = Buffer.alloc(960); for (let i = 0; i < 960; i += 2) b.writeInt16LE(sample, i); return b; };
  gate.push(Buffer.concat([frame(-32768), frame(8), frame(-32), frame(128), frame(129), ...Array.from({length:40},()=>frame(0))]));
  assert.equal(gate.stats.exactZero, 40);
  assert.equal(gate.stats.nearZero, 1);
  assert.equal(gate.stats.peakLe32, 42);
  assert.equal(gate.stats.peakLe128, 43);
  assert.equal(gate.stats.maxPeak, 32768);
  assert.equal(gate.stats.lastPeak, 0);
  assert.equal(gate.stats.quietRunMax, 40);
  assert.equal(gate.speaking, false);
});

test('measured amplitude-one provider tail completes reply and does not restart replying', async () => {
  const f = fixture(); await wake(f);
  const id = f.bridge.sessionId;
  const noise = Buffer.alloc(960);
  for (let i = 0; i < noise.length; i += 2) noise.writeInt16LE(i % 4 ? 1 : -1, i);
  // Reproduce measured near-zero prelude, actual speech, then continuous
  // amplitude-one output. No provider audioDone event is manufactured.
  for (let i = 0; i < 100; i++) {
    f.bridge.event({ type:'audio', relaySessionId:id, audioBase64:noise.toString('base64') }); f.bridge.tick();
  }
  assert.equal(f.binary.length, 0);
  f.bridge.event({ type:'audio', relaySessionId:id, audioBase64:pcm(480).toString('base64') }); f.bridge.tick();
  for (let i = 0; i < 251; i++) {
    f.bridge.event({ type:'audio', relaySessionId:id, audioBase64:noise.toString('base64') }); f.bridge.tick();
  }
  assert.equal(f.closed, false);
  const phases = f.texts.map(JSON.parse).filter(t=>t.type==='phase').map(t=>t.value);
  assert.deepEqual(phases, ['idle','listening','replying','idle']);
  assert.equal(f.binary.length, 41); // Speech + existing 800 ms quiet tail only.
  assert.equal(f.bridge.outputGate.speaking, false);
});

test('tiny-output threshold preserves within-speech pauses and samples above the boundary', () => {
  const frame = value => { const b=Buffer.alloc(960); for(let i=0;i<960;i+=2)b.writeInt16LE(value,i);return b; };
  const gate = new ContinuousOutputGate();
  assert.equal(gate.push(frame(-8)).frames.length, 0);
  const input = Buffer.concat([frame(9), ...Array.from({length:39},()=>frame(-8)), frame(-9)]);
  const output = gate.push(input);
  assert.deepEqual(Buffer.concat(output.frames), input);
  assert.equal(output.ended, false); assert.equal(gate.speaking, true);
  const tail = gate.push(Buffer.concat(Array.from({length:40},()=>frame(8))));
  assert.equal(tail.ended, true); assert.equal(gate.speaking,false);
  assert.equal(gate.push(frame(1)).frames.length, 0);
  assert.deepEqual(gate.push(frame(-9)).frames,[frame(-9)]);
});

test('input overload diagnoses the age of still-pending RPCs, not just completed RTT', async () => {
  let time=0;
  const f=fixture({ now:()=>time, request:async method=>method==='talk.session.create'
    ? {sessionId:'pending-age',audio:contract}:new Promise(()=>{}) });
  await wake(f); f.bridge.audio(pcm(640));
  time=650; f.bridge.audio(pcm(9000));
  const error=f.texts.map(JSON.parse).find(t=>t.type==='error');
  assert.equal(error.code,'input-overload');
  assert.equal(error.transport.inputPendingMaxMs,650);
  assert.equal(error.transport.inputRttMaxMs,0);
});

test('cold 600ms audio RPCs preserve resumed microphone stream without enlarging queue bounds', async () => {
  let time=0;
  const pending=[], sent=[], pieces=[];
  const f=fixture({ now:()=>time, request:(method,params)=> {
    if(method==='talk.session.create')return Promise.resolve({sessionId:'cold-rpc',audio:contract});
    if(method==='talk.session.appendAudio') {
      sent.push(Buffer.from(params.audioBase64,'base64'));
      return new Promise(resolve=>pending.push({at:time+(time<1000?600:150),resolve}));
    }
    return Promise.resolve({});
  } });
  await wake(f);
  for(let i=0;i<300;i++) {
    time=i*20;
    for(let j=pending.length-1;j>=0;j--)if(pending[j].at<=time)pending.splice(j,1)[0].resolve();
    await settle();
    const frame=pcm(320); pieces.push(frame);f.bridge.audio(frame);f.bridge.tick();
    assert.equal(f.closed,false,`closed at ${time}ms`);
    assert(f.bridge.inputBytes<=24000);
  }
  for(let i=0;i<60 && (pending.length||f.bridge.input.length);i++) {
    time+=20;
    for(let j=pending.length-1;j>=0;j--)if(pending[j].at<=time)pending.splice(j,1)[0].resolve();
    await settle();f.bridge.tick();
  }
  const expected=new PcmResampler().push(Buffer.concat(pieces));
  assert.deepEqual(Buffer.concat(sent),expected.subarray(0,Math.floor(expected.length/960)*960));
  assert.equal(f.bridge.maxInputBytes,24000);assert(f.bridge.inflight<=4);
});
