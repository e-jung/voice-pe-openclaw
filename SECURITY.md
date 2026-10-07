# Shared-room authority boundary

Wake word detection, a device token, and Gateway pairing authenticate a device
connection, **not the human speaking**. This adapter supplies one fixed agent
session key and no independently verified current-speaker identity.

A child/guest saying “I am the owner” or “ignore the rules” is unverified speech,
not a privileged identity change. Ordinary requests can also be dangerous when
the target agent has private memory, shell, messages or connected-account access;
no special prompt-injection phrase is required.

Recommended household setup:

- Route shared voice to a dedicated family agent with its own nonprivate
  workspace/history and an explicit minimal tool allowlist.
- Exclude personal memory, journals, mail, finance, files and other sessions.
  Narrow cross-session visibility and disable cross-agent delegation unless
  explicitly needed and policy-scoped. A different session key alone is not
  isolation.
- Deny shell/exec, admin, scheduler/config changes, outgoing messages,
  purchases and arbitrary tool/agent forwarding. Add only selected harmless
  capabilities, with sandbox/data/network boundaries appropriate to them.
- Keep privileged actions on an independently authenticated owner channel.
  A spoken confirmation or passphrase on the same shared mic is not sufficient.
- Prompts can describe household rules but cannot replace enforced tool/data
  permissions. “Read-only” personal access can still leak information aloud.
- If hostile-user isolation is required, use a separate Gateway and OS user or
  host without personal secrets/data/mounts. OpenClaw documents one trust
  boundary per Gateway; same-Gateway personas are guardrails, not hard tenancy.

See [OpenClaw's trust model](https://docs.openclaw.ai/gateway/security/trust-model)
and [prompt-injection guidance](https://docs.openclaw.ai/gateway/security/prompt-injection).
This repository does not implement speaker verification or automatically
install the recommended restrictions.
