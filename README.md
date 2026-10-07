# Voice PE → OpenClaw native Talk

Experimental community device adapter for Home Assistant Voice Preview Edition.
It connects a thin ESPHome audio client to OpenClaw's existing native Talk relay;
it does not implement another assistant, voice provider, prompt, or tool router.
Home Assistant is not required for the conversation backend.

## Architecture

Voice PE (wake/mute/mic/speaker) → adapter (PCM/framing/queues) → Gateway Talk
(provider authentication, conversation and backing-agent policy).

The current prototype targets **OpenClaw 2026.9.8**, Node 24.16+ or 26.1+,
and the authenticated GPT-Live Codex route (`gpt-live-1-codex`, `cove`). Public
OpenAI Realtime credentials are not interchangeable with this route. Other
providers and later SDK versions have not been verified.

Implemented:

- Stateful mono PCM16 16→24 kHz input resampling, ordered pipelined input RPCs,
  bounded startup buffering, bounded output queue and paced playback.
- Firmware `clear-v1` negotiation and matching clear ACK before fresh audio;
  stale relay/turn fencing, stop/re-wake and bounded failures.
- Speech-aware follow-up: 12-second initial window; accepted partial user
  recognition cancels fixed expiry. Subsequent recognition refreshes a
  60-second stall bound, not a total utterance-duration limit. Provider
  endpointing still decides when a thought ends.
- Voice-only +4 dB gain, soft peak protection, unchanged hardware knob/chimes.
  `VoiceBridge.voiceGainDb` supports 0–12 dB; the server currently selects 4
  in source. No automatic gain control or loudness normalization.
- Rotating metadata-only diagnostics, without raw PCM, transcript text,
  credentials or endpoint URLs in adapter telemetry. Gateway/provider
  transcript persistence is separate and remains enabled by their policy.

## Status and evidence

This is a reviewable prototype, not an official integration or turnkey release.
The implementation has run on a private NAS with a real Voice PE. The owner
reported improved voice volume in room conversation. Synthetic-device tests
against the real provider/NAS verified reply, follow-up, silence expiry,
stop/clear and re-wake. A 33.120-second utterance begun 7.5 seconds into the
window was received completely; first recognition arrived around 9.1 seconds.
Local tests include a simulated four-minute recognized turn.

These observations do **not** prove multi-hour reliability, echo-safe duplex,
room acceptance of the new long-turn behavior, all firmware controls, NAS
restart resilience, or compatibility across providers/devices. Raw room logs,
transcripts, audio, host identities and credentials are deliberately excluded.

## Local verification

```sh
npm ci --ignore-scripts
npm test
```

Tests use fake peers and a real local development server. No Gateway or
provider connection, deployment, or firmware flash is performed by `npm test`.

## Runtime setup

First provision a separate approved adapter identity on the Gateway through
the normal pairing flow. This program never pairs or changes Gateway config.
Store credentials outside the checkout/build context, restrict their filesystem
permissions, and supply these variables through your host's private config:

| Variable | Meaning |
| --- | --- |
| `VOICE_PE_DEVICE_TOKEN` | Separate device→adapter bearer token |
| `VOICE_PE_SESSION_KEY` | Stable explicit `agent:<agent-id>:<room-key>` |
| `VOICE_PE_GATEWAY_URL` | Reachable authenticated Gateway WebSocket URL |
| `VOICE_PE_GATEWAY_DEVICE_TOKEN` | Approved adapter identity's token |
| `VOICE_PE_GATEWAY_IDENTITY_FILE` | Host-held identity JSON (`deviceId`, `privateKeyPem`, `publicKeyPem`) |
| `OPENCLAW_GATEWAY_SDK_FILE` | Installed `dist/plugin-sdk/gateway-runtime.js` absolute path |
| `VOICE_PE_BIND` | Defaults to `127.0.0.1` |
| `VOICE_PE_PORT` | Defaults to `8080` |
| `VOICE_PE_LOG_DIR` | Optional private directory for rotating metadata logs |

Then `npm start`. Installed 2026.9.8 requires **both `operator.talk` and
`operator.read`** for audio events and session message subscriptions; the
adapter checks live grants. This is not a claim that broad read scope is the
desired future device contract. Provider credentials stay Gateway-side. The
microcontroller receives only its separate adapter credential.

The server permits one room socket at `/` and one authenticated synthetic
validation socket at `/probe`, using a separate suffixed session key. Neither
is a user-identity or speaker-authentication mechanism. Plain LAN `ws://`
does not encrypt the bearer token; use a reviewed private network or TLS
termination, and do not expose this listener publicly.

`Dockerfile` and `compose.example.yaml` are portable examples, not a published
image or proof of every NAS platform. Set explicit private host paths and a
private bind address. The source targets a pinned installed Gateway SDK and
does not silently change service/network/credential configuration.

## Firmware requirement

Stock community firmware cannot satisfy the playback-clear contract. See
[firmware/README.md](firmware/README.md) for the separate patches and pinned
baseline. This repository contains no flashable binary or personal device stub.

## Important limits

- A persistent session key saves transcripts/backing-agent history, but an
  ordinary fresh relay does not restore all voice-model context. No seamless
  relay renewal or guaranteed late background-result redelivery is claimed.
- Linear interpolation is chunk-correct, not a band-limited resampler.
- Current firmware keeps `barge_in: false`; echo-safe full duplex is unproven.
- Firmware clear ACK means queue cleared and speaker stop requested, not
  measured instantaneous DAC silence. Completion gating is not playback ACK.
- Output completion uses an 800 ms near-digital-silence tail (peak ≤8 PCM16
  units). Overload, stalled recognition and transport faults fail boundedly.
- **Anyone who can wake the device can speak to the configured agent.** For
  shared households, read [SECURITY.md](SECURITY.md) before connecting a
  powerful personal agent.

## Attribution and contribution scope

Adapter code is MIT licensed. Firmware patches retain the upstream licenses;
the C++ changes are GPLv3, not relicensed under the adapter's MIT license.
Based on [voicepe-realtime-firmware](https://github.com/TristanBrotherton/voicepe-realtime-firmware)
and official [ESPHome Voice PE](https://github.com/esphome/home-assistant-voice-pe).
OpenClaw owns Talk semantics; device UX belongs in this adapter/firmware.
See [OpenClaw's Talk SDK guide](https://docs.openclaw.ai/plugins/sdk-migration/talk).
