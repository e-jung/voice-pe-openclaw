import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}
test('real development server retains host logs and reloads source with a new running revision', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-pe-dev-server-'));
  let process, ws, probe;
  try {
    const project = fileURLToPath(new URL('..', import.meta.url));
    await cp(join(project, 'src'), join(root, 'src'), { recursive: true });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
    await mkdir(join(root, 'logs'));
    await writeFile(join(root, 'identity.json'), '{}');
    await writeFile(join(root, 'sdk.mjs'), `
      import { appendFileSync } from 'node:fs';
      export class GatewayClient {
        constructor(options) { this.options = options; }
        start() { setImmediate(() => this.options.onHelloOk({ auth: { scopes: ['operator.talk','operator.read'] } })); }
        stop() {}
        async request(method, params) {
          appendFileSync(process.env.TEST_REQUEST_LOG, method + '\\n');
          if (method === 'sessions.messages.subscribe') return { subscribed:true, key:params.key };
          if (method === 'talk.session.create') {
            setTimeout(() => this.options.onEvent({ event: 'talk.event', payload: { type:'ready', relaySessionId:'fake-relay' } }), 30);
            return { sessionId:'fake-relay', audio:{inputEncoding:'pcm16', outputEncoding:'pcm16',inputSampleRateHz:24000,outputSampleRateHz:24000} };
          }
          return {};
        }
      }
    `);
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(r => reservation.close(r));
    process = spawn(globalThis.process.execPath, ['--watch','--watch-preserve-output',join(root,'src/server.mjs')], {
      env: { ...globalThis.process.env, VOICE_PE_DEVICE_TOKEN:'FAKE_PRIVATE_TOKEN', VOICE_PE_SESSION_KEY:'agent:test:devloop',
        VOICE_PE_GATEWAY_DEVICE_TOKEN:'FAKE_GATEWAY_TOKEN', VOICE_PE_GATEWAY_IDENTITY_FILE:join(root,'identity.json'),
        OPENCLAW_GATEWAY_SDK_FILE:join(root,'sdk.mjs'), VOICE_PE_GATEWAY_URL:'ws://127.0.0.1:1',
        VOICE_PE_BIND:'127.0.0.1', VOICE_PE_PORT:String(port), VOICE_PE_LOG_DIR:join(root,'logs'),
        TEST_REQUEST_LOG:join(root,'requests.log') }, stdio:['ignore','pipe','pipe'],
    });
    let output = ''; process.stdout.on('data', d => { output += d; }); process.stderr.on('data', d => { output += d; });
    const rows = async () => {
      try { return (await readFile(join(root,'logs/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse); }
      catch { return []; }
    };
    await until(async () => (await rows()).some(r => r.event === 'listen'), 'server listen');
    ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers:{ Authorization:'Bearer FAKE_PRIVATE_TOKEN' } });
    await once(ws,'open'); ws.send(JSON.stringify({type:'start',capabilities:['clear-v1']}));
    await sleep(50); ws.send(JSON.stringify({type:'wake'}));
    await until(async () => (await rows()).some(r => r.phase === 'listening'), 'provider-ready phase');
    probe = new WebSocket(`ws://127.0.0.1:${port}/probe`, { headers:{ Authorization:'Bearer FAKE_PRIVATE_TOKEN' } });
    await once(probe,'open'); probe.send(JSON.stringify({type:'start',capabilities:['clear-v1']}));
    await until(async () => (await rows()).some(r => r.event === 'connection' && r.probe === 1), 'separate authenticated probe lane');
    assert.equal(ws.readyState, WebSocket.OPEN);
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/probe`, { headers:{ Authorization:'Bearer WRONG_TOKEN' } });
    const [error] = await once(rejected,'error'); assert.match(error.message,/401/);
    rejected.terminate();
    const first = (await rows()).find(r => r.event === 'startup');
    const source = await readFile(join(root,'src/audio.mjs'),'utf8');
    await writeFile(join(root,'src/audio.mjs.next'),source+'\n// atomic development reload test\n');
    await rename(join(root,'src/audio.mjs.next'),join(root,'src/audio.mjs'));
    await until(async () => (await rows()).filter(r => r.event === 'startup').length >= 2, 'watch restart');
    const after = await rows(), startups = after.filter(r => r.event === 'startup');
    assert.notEqual(first.revision,startups.at(-1).revision);
    assert(after.some(r => r.event === 'shutdown'));
    assert((await readFile(join(root,'requests.log'),'utf8')).includes('talk.session.close'));
    assert(!JSON.stringify(after).includes('FAKE_PRIVATE_TOKEN'));
    assert(!JSON.stringify(after).includes('FAKE_GATEWAY_TOKEN'));
    assert(!output.includes('FAKE_PRIVATE_TOKEN'));
  } finally {
    ws?.terminate();
    probe?.terminate();
    if (process && process.exitCode === null) { process.kill('SIGTERM'); await once(process,'exit'); }
    await rm(root,{ recursive:true,force:true });
  }
});
