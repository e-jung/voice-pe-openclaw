# Separate firmware review material

Baseline: `TristanBrotherton/voicepe-realtime-firmware` commit
`e9b874db0a6cd0950e6db9cd22a3e4499a4a6933`, official `voice_kit` snapshot
`d4e6fa43d6a1a7d342b7d4d403567e06516719de`, ESPHome 2026.9.0.

- `standalone.patch`: guarded wake startup without an HA API client,
  `reboot_timeout: 0s`, Okay Nabu default, and pinned assets/local components.
  This is an exported review diff, not a self-contained package: the local
  component snapshots referenced by its YAML must be supplied from the pinned
  upstream sources. Do not blindly apply it as a ready-to-flash config.
- `clear-v1.patch`: client advertises clear capability; server clear empties
  PSRAM playback, requests speaker stop and acknowledges its sequence. A single
  outstanding clear must be matched before sending fresh PCM. Queue clear is
  not a physical DAC-silence measurement.

The coordinated local firmware compiled and was deployed during prototype work.
Repeated cold-boot, full controls/enrollment/timer regression, acoustic stop and
echo acceptance are not asserted here. These changes need separate firmware
upstream review, not inclusion in OpenClaw core.

No binaries, Wi-Fi credentials, API/OTA keys or device configuration are
included. Preserve upstream licensing in `LICENSE`; C++/runtime portions are
GPLv3. XMOS is a separate update/rollback surface: the baseline bundles v1.3.1
and may automatically DFU on version mismatch. Backing up ESP32 flash alone
does not back up XMOS firmware.
