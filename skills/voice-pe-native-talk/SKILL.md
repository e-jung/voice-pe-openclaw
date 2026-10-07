---
name: voice-pe-native-talk
description: Install, configure, verify, and maintain the experimental community Voice Preview Edition adapter for OpenClaw native Talk; includes private-host setup, shared-room agent boundaries, and firmware-clear prerequisites.
homepage: https://github.com/e-jung/voice-pe-openclaw
metadata:
  openclaw:
    emoji: "🎙️"
    requires:
      bins: ["node", "npm", "openclaw"]
---

# Voice PE native Talk setup

1. Inspect the intended Gateway, adapter host, device firmware, existing routing, and current agent permissions. Explain the architecture: Voice PE owns wake/mute/mic/speaker; the host adapter owns PCM framing and queues; Gateway native Talk owns provider credentials, agent consultation, and transcript persistence. This is an experimental external adapter, not a built-in plugin or new assistant backend. **Done:** owner has selected the private host and intended room agent; existing configuration is recorded without secrets.

2. Read the pinned source README, SECURITY.md, and firmware/README.md at https://github.com/e-jung/voice-pe-openclaw/tree/60b11c3c3a2afa447454ffdaf500a5d0751e727e. Tested host: OpenClaw **2026.9.8**; Node >=24.16.0 <25 or >=26.1.0; authenticated GPT-Live Codex `gpt-live-1-codex` / `cove`. Public Realtime API credentials are not interchangeable. Do not silently upgrade the Gateway or promise other provider/version compatibility. **Done:** prerequisites match, or mismatches are reported before deployment.

3. For a shared room, create a separate agent/workspace and fresh explicit `agent:<room-agent>:<room-key>`; never copy private owner memory or history into it. Disable memory search and inherited external memory paths, remove personal skills, and enforce a narrow tool policy. Start conversation-only unless the owner requests particular household tools. Wake words, device pairing, claimed identity, and a spoken approval do not authenticate a person. A different session alone is not a security boundary. Check memory-plugin automatic context injection and runtime-native tools as well as advertised OpenClaw tools. Use an embedded text model compatible with the restrictions; never grant shell just to make a CLI-backed model start. If inherited additive allowlists cause a zero-tool guard failure, inspect the effective policy and preserve the private agent's capabilities while scoping those additions away from the room agent. **Done:** a real test turn's system-prompt report contains only the room workspace files and the intended tool surface, with no private memory/wiki material.

4. Obtain the reviewed source and perform an offline smoke check in a separate directory:

   ```sh
   git clone https://github.com/e-jung/voice-pe-openclaw.git
   cd voice-pe-openclaw
   git checkout 60b11c3c3a2afa447454ffdaf500a5d0751e727e
   npm ci --ignore-scripts
   npm test
   ```

   This check needs GitHub/npm network access and local file/process access, but no Gateway credentials, provider calls, room audio, or firmware flash. The published baseline has 51 passing tests. **Done:** tests pass on the selected compatible Node host.

5. Follow README Runtime setup. Provision a separate approved adapter identity through normal Gateway pairing; do not reuse an unrestricted personal token or print credentials. Required private config: `VOICE_PE_DEVICE_TOKEN`, `VOICE_PE_SESSION_KEY`, `VOICE_PE_GATEWAY_URL`, `VOICE_PE_GATEWAY_DEVICE_TOKEN`, `VOICE_PE_GATEWAY_IDENTITY_FILE`, and `OPENCLAW_GATEWAY_SDK_FILE`. Optional bind/port/log settings are documented there. Keep tokens/identity/env outside the source/build context with restricted permissions. Installed 2026.9.8 needs `operator.talk` and `operator.read`; do not broaden grants on failure. Provider secrets remain Gateway-side and the microcontroller receives only its adapter credential. Use private networking or reviewed TLS termination; do not publish the LAN listener. **Done:** selected session belongs to the restricted room agent and the authenticated private Gateway route is proven.

6. For authorized host deployment, inspect and preserve existing services/Compose/network settings, use Dockerfile/compose.example.yaml or `npm start`, and pin the installed SDK path. Do not execute container builds, expose a listener, change config, create identities, restart unrelated services, or flash firmware merely because this skill is installed. An explicit installation request authorizes necessary reversible setup; explain any genuinely separate destructive or privileged step. Firmware must implement `clear-v1` and matching clear ACK; published patches retain upstream licensing and are not a flashable device binary. **Done:** running source revision and listener are verified, not merely staged source or image-build success.

7. Verify wake → reply → follow-up → silence expiry → fresh wake; stop during reply and recover. Test a long thought begun near the old eight-second boundary. Use an isolated synthetic probe lane before physical room tests; never forward probe audio to the room speaker or retain PCM/transcripts in adapter diagnostics. Verify transcript/session ownership under the selected room agent, not main. Adapter telemetry is metadata-only; Gateway/provider transcript storage is separate. **Done:** each reported acceptance test has observed evidence; distinguish simulated-device/provider proof from physical acoustic proof.

## Updates and troubleshooting

Review source changes, rerun offline tests, preserve runtime configuration and rollback files, and verify the actual running revision after updates. Do not call a staged upload deployed. Never solve a permissions or authentication error by routing back to an unrestricted personal agent.

Follow-up starts with a 12-second window; recognized partial speech cancels fixed expiry and subsequent recognition refreshes a 60-second stall guard. Provider endpointing may still end a thought after a pause. Output-only +4 dB trim does not change hardware master/chimes. Firmware playback ACK is not measured DAC silence. Echo-safe duplex, sustained reliability, host restart resilience, other SDK/provider compatibility, seamless renewal, and guaranteed late-result delivery remain unproven; report these limits without presenting them as shipped features.

Full source, installation examples, license/attribution, architecture, permission notes, and acceptance evidence are linked from the pinned README above. This skill installs the setup workflow; the separate Node adapter and compatible firmware still require explicit host/device setup.
