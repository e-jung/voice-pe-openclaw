import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { VoiceBridge } from './bridge.mjs';
import { createTelemetry, sourceFingerprint } from './telemetry.mjs';

// Explicit host-held credentials only. This program never pairs a device,
// changes config, reads provider secrets, or creates/stores identities/tokens.
function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}
function equalToken(a, b) {
  const left = Buffer.from(a ?? ''), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
const deviceToken = requireEnv('VOICE_PE_DEVICE_TOKEN');
const sessionKey = requireEnv('VOICE_PE_SESSION_KEY');
const gatewayToken = requireEnv('VOICE_PE_GATEWAY_DEVICE_TOKEN');
const deviceIdentity = JSON.parse(await readFile(requireEnv('VOICE_PE_GATEWAY_IDENTITY_FILE'), 'utf8'));
const sdkPath = requireEnv('OPENCLAW_GATEWAY_SDK_FILE');
const { GatewayClient } = await import(pathToFileURL(sdkPath).href);
const telemetry = createTelemetry({ directory: process.env.VOICE_PE_LOG_DIR, fingerprint: await sourceFingerprint() });
const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
// One physical device, plus one authenticated synthetic-device validation lane.
// The latter never shares the room session or forwards output to its socket.
const occupied = new Set();
const connectionCleanups = new Set();
http.on('upgrade', (req, socket, head) => {
  const lane = req.url;
  if (!['/', '/probe'].includes(lane) || occupied.has(lane) || !equalToken(req.headers.authorization, `Bearer ${deviceToken}`)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
  }
  occupied.add(lane);
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, lane));
});
wss.on('connection', (ws, lane) => {
  const probe = lane === '/probe';
  const observe = telemetry.connection(); observe('connection', { connected: 1, probe: Number(probe) });
  let authorized = false, bridge, timer, heartbeat, pong = true;
  const pendingMessages = [];
  const client = new GatewayClient({
    url: requireEnv('VOICE_PE_GATEWAY_URL'), deviceToken: gatewayToken, deviceIdentity,
    sharedStateMode: 'read-only', clientName: 'gateway-client', clientDisplayName: 'Voice PE adapter MVP',
    clientVersion: '0.0.1', platform: process.platform, mode: 'backend', role: 'operator',
    scopes: ['operator.talk', 'operator.read'],
    onHelloOk: hello => {
      if (!['operator.talk', 'operator.read'].every(scope => hello.auth?.scopes?.includes(scope))) {
        bridge.fail('gateway-talk-and-read-scopes-required'); return;
      }
      authorized = true;
      observe('gateway_ready', { ready: 1 });
      for (const message of pendingMessages.splice(0)) consume(...message);
    },
    onEvent: event => {
      if (event.event === 'talk.event') bridge.event(event.payload);
      else if (event.event === 'agent') bridge.agentEvent(event.payload);
    },
    onGap: () => bridge.fail('gateway-event-gap'),
    onConnectError: () => bridge.fail('gateway-connect-failed'),
    onClose: () => bridge.fail('gateway-disconnected')
  });
  // Room calibration: shared hardware knob stays master; trim only native voice.
  // Source-only tuning avoids changing NAS environment/recreating the container.
  bridge = new VoiceBridge({ gateway: client, sessionKey: probe ? `${sessionKey}:probe` : sessionKey, observe, voiceGainDb: 4, device: {
    sendText: text => { if (ws.readyState === ws.OPEN) ws.send(text); },
    sendBinary: data => { if (ws.readyState === ws.OPEN) ws.send(data, { binary: true }); },
    bufferedAmount: () => ws.bufferedAmount,
    close: () => ws.close(1011, 'adapter call ended')
  } });
  function consume(data, binary) {
    if (binary) bridge.audio(data);
    else bridge.control(data.toString()).catch(() => bridge.fail('invalid-device-control'));
  }
  ws.on('message', (data, binary) => {
    if (!authorized) {
      // Only bounded initial controls, never pre-auth audio buffering.
      if (binary || pendingMessages.length >= 4 || data.length > 2048) return bridge.fail('gateway-not-ready');
      pendingMessages.push([data, binary]); return;
    }
    consume(data, binary);
  });
  timer = setInterval(() => bridge.tick(), 20);
  heartbeat = setInterval(() => {
    if (!pong) { bridge.fail('device-unresponsive'); ws.terminate(); return; }
    pong = false; ws.ping();
  }, 10000);
  ws.on('pong', () => { pong = true; });
  ws.on('error', () => bridge.fail('device-connection-failed'));
  let cleanupPromise;
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      observe('disconnect', { connected: 0 });
      clearInterval(timer); clearInterval(heartbeat);
      try { await bridge.disconnect(); }
      finally { client.stop(); occupied.delete(lane); connectionCleanups.delete(cleanup); }
    })();
    return cleanupPromise;
  }
  connectionCleanups.add(cleanup);
  ws.on('close', () => { void cleanup(); });
  client.start();
});
// Loopback default prevents accidental LAN exposure. Deployment is a separate step.
http.listen(Number(process.env.VOICE_PE_PORT ?? 8080), process.env.VOICE_PE_BIND ?? '127.0.0.1', () => {
  telemetry.emit('listen', { port: Number(process.env.VOICE_PE_PORT ?? 8080) });
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  telemetry.emit('shutdown');
  const deadline = setTimeout(() => process.exit(0), 2500);
  for (const ws of wss.clients) ws.close(1001, 'adapter restarting');
  http.close();
  await Promise.allSettled([...connectionCleanups].map(cleanup => cleanup()));
  await telemetry.close(); clearTimeout(deadline); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
