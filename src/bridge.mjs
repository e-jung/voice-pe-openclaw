import { PcmResampler, PlaybackQueue, ContinuousOutputGate, voiceGain } from './audio.mjs';

// Four seconds of recognition grace beyond the old eight-second start window.
// Measured provider first-partial latency was ~1.5 s; don't lose speech begun
// near that old boundary before streaming recognition can cancel expiry.
const HELLO = { type: 'hello', proto: 2, audio_out: 'pcm', follow_up_ms: 12000,
  follow_up_open_delay_ms: 1500, wake_open_delay_ms: 700, playback_prebuffer_ms: 200, trigger_capture: 0 };

// One device / one Gateway connection. No second assistant, VAD, or tool router.
export class VoiceBridge {
  constructor({ gateway, device, sessionKey, maxInputBytes = 24000,
    maxStartupInputBytes = 720000, now = Date.now, observe = () => {}, voiceGainDb = 0 }) {
    if (!sessionKey?.startsWith('agent:')) throw new Error('explicit agent sessionKey required');
    this.gateway = gateway; this.device = device; this.sessionKey = sessionKey;
    voiceGain(Buffer.alloc(0), voiceGainDb); // Validate once, before opening any call.
    this.voiceGainDb = voiceGainDb;
    this.observe = (event, fields) => { try { observe(event, fields); } catch { /* Diagnostics must not affect audio. */ } };
    this.maxInputBytes = maxInputBytes; this.now = now;
    // Up to the 15-second ready deadline at 24 kHz PCM16. Provider startup
    // must not consume the much smaller steady-state backpressure budget.
    this.maxStartupInputBytes = maxStartupInputBytes; this.startupBuffering = false;
    this.resampler = new PcmResampler(); this.playback = new PlaybackQueue();
    this.outputGate = new ContinuousOutputGate(); this.lastPhase = null;
    this.playbackDue = null;
    this.sessionId = null; this.ready = false; this.active = false; this.closed = false;
    this.epoch = 0; this.input = []; this.inputBytes = 0; this.inflight = 0;
    this.partial = Buffer.alloc(0); this.ackSent = false;
    this.clearSeq = 0; this.clearWait = null; this.clearDeadline = 0;
    this.pendingEvents = []; this.creating = false; this.clearCapable = false;
    this.finishPending = false; this.marks = [];
    this.outputTurn = null; this.discardedTurns = new Set();
    this.metrics = { inputBytes: 0, outputBytes: 0, clears: 0, failures: 0 };
    this.transportStats = { inputQueueMax: 0, inputRttMaxMs: 0, tickGapMaxMs: 0, playbackQueueMax: 0 };
    this.inputRequests = new Set(); this.transportStats.inputPendingMaxMs = 0;
    this.lastTickAt = null;
    this.lastDiagnosticsAt = this.now();
    this.controlChain = Promise.resolve();
    this.controlPending = 0;
    this.agentRuns = new Map(); this.retiredAgentRuns = new Set();
    this.awaitingAnswer = false; this.answerDeadline = 0; this.answerAudioStarted = false;
    this.subscribed = false;
    this.speechPending = false; this.speechDeadline = 0;
  }
  text(value) { if (!this.closed) this.device.sendText(JSON.stringify(value)); }
  diagnostics(sendToDevice = true) {
    this.lastDiagnosticsAt = this.now();
    for (const request of this.inputRequests) {
      if (request.epoch === this.epoch)
        this.transportStats.inputPendingMaxMs = Math.max(this.transportStats.inputPendingMaxMs, this.now() - request.sentAt);
    }
    if (sendToDevice) this.text({ type: 'diagnostics', transport: this.transportStats, output: this.outputGate.stats,
      flow: { inputBytes: this.metrics.inputBytes, outputBytes: this.metrics.outputBytes,
        inputQueued: this.inputBytes, playbackQueued: this.playback.bytes, inflight: this.inflight,
        speaking: Number(this.outputGate.speaking), quietFrames: this.outputGate.quietFrames } });
    this.observe('snapshot', { ...this.transportStats, ...this.outputGate.stats,
      inputBytes: this.metrics.inputBytes, outputBytes: this.metrics.outputBytes,
      inputQueued: this.inputBytes, playbackQueued: this.playback.bytes, inflight: this.inflight,
      speaking: Number(this.outputGate.speaking), quietFrames: this.outputGate.quietFrames,
      epoch: this.epoch, active: Number(this.active), ready: Number(this.ready), clearPending: Number(this.clearWait !== null) });
  }
  phase(value, extra = {}) {
    const phase = { type: 'phase', value, ...extra }, signature = JSON.stringify(phase);
    if (signature === this.lastPhase) return;
    this.lastPhase = signature; this.text(phase);
    this.observe('phase', { phase: value, epoch: this.epoch });
  }
  async control(message) {
    if ((typeof message === 'string' && message.length > 4096) || this.controlPending >= 16)
      throw new Error('device control overload');
    const parsed = typeof message === 'string' ? JSON.parse(message) : message;
    // Serializes control transitions while audio is independently bounded.
    this.controlPending++;
    const operation = this.controlChain.then(() => this.handleControl(parsed)).finally(() => { this.controlPending--; });
    this.controlChain = operation.catch(() => {});
    return operation;
  }
  async handleControl(msg) {
    if (this.closed) return;
    this.observe('device_control', { control: msg.type, seq: msg.seq, epoch: this.epoch });
    switch (msg.type) {
      case 'start':
        this.clearCapable = msg.capabilities?.includes('clear-v1') === true;
        if (!this.clearCapable) return this.fail('firmware-clear-v1-required');
        // Plain idle cannot open a follow-up window. followup:false is sticky
        // in this firmware until the next reply, so never attach it at hello.
        this.text(HELLO); this.phase('idle'); break;
      case 'wake':
        if (!this.clearCapable) return this.fail('firmware-clear-v1-required');
        // Re-wake intentionally replaces the relay: no stale response can win.
        if (this.sessionId) { this.beginClear(); await this.endSession(); }
        this.active = true; this.ackSent = false;
        await this.createSession(); break;
      case 'interrupt':
        this.beginClear();
        // GPT-Live reason=barge-in is a no-op. Physical stop explicitly ends call.
        if (this.sessionId) {
          await this.gateway.request('talk.session.cancelOutput', { sessionId: this.sessionId, reason: 'device-stop' });
        }
        await this.endSession(); break;
      case 'flush':
        // A flush already in flight can race the first partial transcript.
        // Provider-confirmed ongoing speech is not an abandoned silent window.
        if (this.speechPending) {
          this.lastPhase = null; this.phase('listening'); return;
        }
        // Firmware can expire a window opened by a short acknowledgement.
        // A mic timeout is not permission to cancel accepted agent work.
        if (this.agentRuns.size || this.awaitingAnswer) {
          this.observe('work', { action: 'flush_ignored', epoch: this.epoch });
          this.lastPhase = null; this.phase('thinking'); return;
        }
        // Discard, NEVER commitAudio. Sent partial input cannot be retracted
        // through the installed relay API, so terminate this call at expiry.
        this.beginClear(); await this.endSession(); break;
      case 'cleared':
        if (msg.seq === this.clearWait) {
          this.clearWait = null; this.clearDeadline = 0;
          if (this.active && this.ready) this.phase('listening');
          // A replacement call may still be starting. Idle here would shut
          // its freshly opened microphone before the provider becomes ready.
          else if (!this.active) this.phase('idle');
        }
        break;
      default: break; // Optional diagnostics deliberately not recorded.
    }
  }
  async createSession() {
    const epoch = ++this.epoch;
    this.sessionStartedAt = this.now();
    this.creating = true; this.ready = false; this.pendingEvents = []; this.readyDeadline = this.now() + 15000;
    this.startupBuffering = true;
    this.observe('session', { action: 'create_requested', epoch });
    try {
      if (!this.subscribed) {
        const subscription = await this.gateway.request('sessions.messages.subscribe', { key: this.sessionKey });
        if (subscription?.subscribed !== true || subscription.key !== this.sessionKey)
          throw new Error('exact session subscription unavailable');
        if (this.closed || epoch !== this.epoch) return;
        this.subscribed = true;
      }
      const result = await this.gateway.request('talk.session.create', {
        mode: 'realtime', transport: 'gateway-relay', brain: 'agent-consult',
        provider: 'openai', model: 'gpt-live-1-codex', voice: 'cove', sessionKey: this.sessionKey
      });
      if (this.closed || epoch !== this.epoch) {
        await this.gateway.request('talk.session.close', { sessionId: result.sessionId ?? result.relaySessionId }); return;
      }
      this.sessionId = result.sessionId ?? result.relaySessionId;
      if (!this.sessionId) throw new Error('missing relay id');
      this.observe('session', { action: 'created', epoch });
      // Pinned negotiated-format check: never silently play a different codec.
      if (!validAudio(result.audio)) throw new Error('unsupported negotiated audio');
      this.expiresAt = result.expiresAt;
      this.creating = false;
      const early = this.pendingEvents; this.pendingEvents = [];
      for (const event of early) this.event(event);
    } catch { this.fail('native-session-unavailable'); }
  }
  agentEvent(event) {
    // This connection observes only its room/probe conversation. Never infer
    // work from transcript wording, other agents, or another session's runs.
    if (this.closed || !this.active || event?.sessionKey !== this.sessionKey
        || event.stream !== 'lifecycle' || typeof event.runId !== 'string'
        || !/^talk-realtime-relay-consult-/.test(event.runId)) return;
    const { runId } = event, phase = event.data?.phase;
    if (typeof event.data?.startedAt === 'number' && event.data.startedAt < this.sessionStartedAt) return;
    if (phase === 'start') {
      if (this.retiredAgentRuns.has(runId) || this.agentRuns.has(runId)) return;
      if (this.agentRuns.size >= 4) return this.fail('agent-work-overload');
      this.agentRuns.set(runId, this.now() + 180000);
      this.speechPending = false; this.speechDeadline = 0;
      this.awaitingAnswer = false; this.answerDeadline = 0; this.answerAudioStarted = false;
      this.observe('work', { action: 'started', epoch: this.epoch });
      if (!this.outputGate.speaking && !this.playback.bytes) this.phase('thinking');
    } else if ((phase === 'end' || phase === 'error') && this.agentRuns.has(runId)) {
      this.agentRuns.delete(runId); this.retireAgentRun(runId);
      if (event.data?.aborted || phase === 'error') {
        if (!this.agentRuns.size) return this.fail('agent-work-failed');
        return; // A superseding run already owns the new request.
      }
      this.observe('work', { action: 'completed', epoch: this.epoch });
      if (!this.agentRuns.size) {
        // Backend completion precedes the live model speaking its result.
        // Do not open an idle window in that synthesis gap.
        this.awaitingAnswer = true; this.answerDeadline = this.now() + 30000;
        this.answerAudioStarted = this.outputGate.speaking || this.playback.bytes > 0;
        this.finishPending = false;
        if (!this.answerAudioStarted) this.phase('thinking');
      }
    }
  }
  retireAgentRun(runId) {
    this.retiredAgentRuns.add(runId);
    if (this.retiredAgentRuns.size > 64) this.retiredAgentRuns.delete(this.retiredAgentRuns.values().next().value);
  }
  audio(bytes) {
    if (this.closed || !this.active) return;
    if (bytes.length > 32000) return this.fail('input-frame-too-large');
    const converted = this.resampler.push(bytes);
    this.metrics.inputBytes += bytes.length;
    this.partial = Buffer.concat([this.partial, converted]);
    const queuedAt = this.now();
    while (this.partial.length >= 960) {
      this.input.push({ pcm: Buffer.from(this.partial.subarray(0, 960)), epoch: this.epoch, queuedAt });
      this.partial = this.partial.subarray(960); this.inputBytes += 960;
    }
    const inputLimit = this.startupBuffering ? this.maxStartupInputBytes : this.maxInputBytes;
    this.transportStats.inputQueueMax = Math.max(this.transportStats.inputQueueMax, this.inputBytes + this.partial.length);
    if (this.inputBytes + this.partial.length > inputLimit) return this.fail('input-overload');
    this.pumpInput();
  }
  pumpInput() {
    if (!this.ready || !this.sessionId || this.closed) return;
    if (this.inputBytes + this.partial.length <= this.maxInputBytes) this.startupBuffering = false;
    while (this.input.length && this.inflight < 4) {
      // Keep the first two slots low-latency, but under RPC pressure reserve
      // the remaining slots for >=80ms batches (or a <=60ms bounded wait).
      // Four cold 20ms RPCs consume every slot yet cover only 80ms of audio;
      // a 600ms RTT then overflows the unchanged 500ms queue before any ACK.
      // Timer pumping also releases a final short batch after the wait.
      if (!this.startupBuffering && this.inflight >= 2 && this.input.length < 4
          && this.now() - this.input[0].queuedAt < 60) return;
      // Coalesce only already queued 20 ms frames (at most 240 ms per RPC).
      // Four single-frame RPCs require <80 ms round trips to sustain realtime
      // input; a tailnet latency spike otherwise grows the queue every second.
      // The pressure gate above is the only added wait; no samples are dropped
      // and neither queues nor the four-request bound are enlarged.
      const frame = this.input.shift(); this.inputBytes -= frame.pcm.length;
      if (frame.epoch !== this.epoch) continue;
      const batch = [frame.pcm];
      while (batch.length < 12 && this.input[0]?.epoch === frame.epoch) {
        const next = this.input.shift(); this.inputBytes -= next.pcm.length;
        batch.push(next.pcm);
      }
      if (this.inputBytes + this.partial.length <= this.maxInputBytes) this.startupBuffering = false;
      const sessionId = this.sessionId, epoch = this.epoch, sentAt = this.now();
      const request = { epoch, sentAt }; this.inputRequests.add(request);
      this.inflight++;
      this.gateway.request('talk.session.appendAudio', { sessionId, audioBase64: Buffer.concat(batch).toString('base64') })
        .then(() => {
          if (epoch === this.epoch) this.transportStats.inputRttMaxMs = Math.max(this.transportStats.inputRttMaxMs, this.now() - sentAt);
          if (!this.closed && epoch === this.epoch && !this.ackSent) { this.ackSent = true; this.text({ type: 'ack' }); }
        }).catch(() => { if (epoch === this.epoch) this.fail('input-send-failed'); })
        .finally(() => { this.inputRequests.delete(request); this.inflight--; this.pumpInput(); });
    }
  }
  event(event) {
    if (this.closed) return;
    if (this.creating && !this.sessionId) {
      if (this.pendingEvents.length >= 100) return this.fail('startup-event-overload');
      this.pendingEvents.push(event); return;
    }
    if (event.relaySessionId !== this.sessionId || !this.sessionId) return;
    if (['ready', 'clear', 'audioDone', 'transcript', 'mark', 'error', 'close'].includes(event.type)
        && (event.type !== 'transcript' || event.final))
      this.observe('provider_event', { provider: event.type, role: event.role, final: Number(event.final === true), epoch: this.epoch });
    switch (event.type) {
      case 'ready':
        this.ready = true; this.readyDeadline = 0;
        if (this.clearWait === null && this.active) this.phase('listening');
        this.pumpInput(); break;
      case 'audio':
        // Do not retain audio arriving before the device confirms its clear.
        if (this.clearWait !== null) return;
        if (event.talkEvent?.turnId && this.discardedTurns.has(event.talkEvent.turnId)) return;
        this.outputTurn = event.talkEvent?.turnId ?? this.outputTurn;
        try {
          const output = this.outputGate.push(Buffer.from(event.audioBase64, 'base64'));
          for (const frame of output.frames) this.playback.push(voiceGain(frame, this.voiceGainDb));
          this.transportStats.playbackQueueMax = Math.max(this.transportStats.playbackQueueMax, this.playback.bytes);
          if (this.outputGate.speaking) this.finishPending = false;
          if (this.outputGate.speaking) { this.speechPending = false; this.speechDeadline = 0; }
          if (this.awaitingAnswer && this.outputGate.speaking) {
            this.answerAudioStarted = true;
            this.answerDeadline = this.now() + 30000;
          }
          if (output.ended) this.finishPending = true;
        }
        catch { this.fail('playback-overload'); }
        break;
      case 'clear': this.beginClear(); break;
      case 'audioDone':
        if (!event.talkEvent?.turnId || !this.discardedTurns.has(event.talkEvent.turnId)) this.finishPending = true;
        break;
      case 'transcript':
        // Use the provider's existing streaming recognition, not energy VAD
        // (which would mistake room noise for speech). Firmware listening
        // cancels va_followup while leaving the mic on. Do NOT commit audio
        // or force a provider response; it still decides utterance completion.
        if (event.role === 'user' && typeof event.text === 'string' && event.text.trim()
            && this.active && this.ready && this.clearWait === null
            && !this.playback.bytes && !this.outputGate.speaking
            && !this.agentRuns.size && !this.awaitingAnswer
            && !this.discardedTurns.has(event.talkEvent?.turnId)) {
          if (!event.final) {
            if (!this.speechPending)
              this.observe('provider_event', { provider: 'transcript', role: 'user', final: 0, epoch: this.epoch });
            this.speechPending = true; this.speechDeadline = this.now() + 60000;
            this.phase('listening');
          } else { this.speechPending = false; this.speechDeadline = 0; }
        }
        // Provider-confirmed utterance, not local microphone VAD. Keep the
        // mic on while processing and cancel firmware's fixed follow-up timer
        // so it cannot flush a request already accepted by the voice provider.
        if (event.role === 'user' && event.final && this.active && this.clearWait === null && !this.playback.bytes && !this.outputGate.speaking)
          this.phase('thinking');
        break;
      case 'mark':
        if (this.marks.length >= 100) return this.fail('unacknowledged-mark-overload');
        this.marks.push(event.markName); break;
      case 'error': this.fail('native-audio-error'); break;
      case 'close':
        this.sessionId = null; this.ready = false; this.active = false;
        this.beginClear(); break;
      default: break;
    }
  }
  beginClear() {
    this.speechPending = false; this.speechDeadline = 0;
    this.outputGate.reset();
    this.lastPhase = null; // clear ACK must reassert listening even if unchanged
    this.playback.clear(); this.finishPending = false; this.marks = [];
    this.playbackDue = null;
    if (this.outputTurn) {
      this.discardedTurns.add(this.outputTurn); this.outputTurn = null;
      if (this.discardedTurns.size > 100) this.discardedTurns.delete(this.discardedTurns.values().next().value);
    }
    // Firmware supports one in-flight hardware-clear operation at a time.
    if (this.clearWait !== null) return;
    this.clearWait = ++this.clearSeq; this.clearDeadline = this.now() + 2000;
    this.metrics.clears++;
    this.text({ type: 'clear', seq: this.clearWait });
  }
  tick() {
    if (this.closed) return;
    const tickAt = this.now();
    if (this.lastTickAt !== null) this.transportStats.tickGapMaxMs = Math.max(this.transportStats.tickGapMaxMs, tickAt - this.lastTickAt);
    this.lastTickAt = tickAt;
    this.pumpInput();
    if ([...this.agentRuns.values()].some(deadline => tickAt >= deadline)) return this.fail('agent-work-timeout');
    if (this.awaitingAnswer && tickAt >= this.answerDeadline) return this.fail('agent-answer-timeout');
    // Not a total speaking limit: every new recognized fragment refreshes
    // this bound. A broken provider cannot leave a confirmed turn open forever.
    if (this.speechPending && !this.agentRuns.size && !this.awaitingAnswer
        && tickAt >= this.speechDeadline) return this.fail('user-speech-stalled');
    // End-only diagnostics are absent precisely when continuous output gets
    // stuck. Emit bounded numeric snapshots, without audio/transcript storage
    // or any change to completion thresholds or microphone control.
    if (this.active && this.ready && tickAt - this.lastDiagnosticsAt >= 5000) this.diagnostics();
    if (!this.ready && this.active && this.readyDeadline && this.now() >= this.readyDeadline)
      return this.fail('native-ready-timeout');
    if (this.clearWait !== null) {
      if (this.now() >= this.clearDeadline) this.fail('device-clear-timeout');
      return;
    }
    if ((this.device.bufferedAmount?.() ?? 0) > 4800) return this.fail('device-socket-overload');
    // Timers are wakeups, not the audio clock: setInterval(20) loses playback
    // capacity whenever the NAS event loop runs late. Catch up against elapsed
    // time, capped at 100 ms per tick; never accumulate credits while idle.
    const time = tickAt;
    if (this.playback.bytes && this.playbackDue === null) this.playbackDue = time;
    let sent = 0;
    while (this.playback.bytes && time >= this.playbackDue && sent < 5) {
      if ((this.device.bufferedAmount?.() ?? 0) > 4800) return this.fail('device-socket-overload');
      const data = this.playback.shift();
      this.phase('replying'); this.device.sendBinary(data); this.metrics.outputBytes += data.length;
      this.playbackDue += 20; sent++;
    }
    if (!this.playback.bytes) {
      this.playbackDue = null;
      // No playback ACK in firmware: marks are not acknowledged based merely on send.
      if (this.finishPending) {
        this.finishPending = false;
        this.diagnostics();
        if (this.agentRuns.size || (this.awaitingAnswer && !this.answerAudioStarted)) this.phase('thinking');
        else {
          this.awaitingAnswer = false; this.answerDeadline = 0; this.answerAudioStarted = false;
          this.phase('idle');
        }
      }
    }
  }
  async endSession() {
    this.speechPending = false; this.speechDeadline = 0;
    const id = this.sessionId;
    if (id) this.observe('session', { action: 'stop_requested', epoch: this.epoch });
    this.sessionId = null; this.epoch++; this.ready = false; this.active = false;
    for (const runId of this.agentRuns.keys()) this.retireAgentRun(runId);
    this.agentRuns.clear(); this.awaitingAnswer = false; this.answerDeadline = 0; this.answerAudioStarted = false;
    this.input = []; this.inputBytes = 0; this.partial = Buffer.alloc(0); this.resampler.reset();
    this.startupBuffering = false;
    this.playback.clear(); this.pendingEvents = []; this.creating = false;
    this.playbackDue = null;
    this.outputGate.reset();
    this.outputTurn = null; this.discardedTurns.clear();
    if (id) await this.gateway.request('talk.session.close', { sessionId: id }).catch(() => {});
    if (id) this.observe('session', { action: 'closed', epoch: this.epoch });
  }
  fail(code) {
    if (this.closed) return;
    this.metrics.failures++;
    this.diagnostics(false);
    this.observe('failure', { code, epoch: this.epoch });
    this.text({ type: 'error', audible: true, code, transport: this.transportStats, output: this.outputGate.stats });
    this.beginClear(); this.closed = true;
    void this.endSession(); this.device.close();
  }
  async disconnect() { this.closed = true; await this.endSession(); }
}

function validAudio(audio) {
  return audio?.inputEncoding === 'pcm16' && audio?.outputEncoding === 'pcm16'
    && audio.inputSampleRateHz === 24000 && audio.outputSampleRateHz === 24000;
}
