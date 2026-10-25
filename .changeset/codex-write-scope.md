---
'@open-slide/core': patch
---

Codex in the agent panel can now write only to the deck folders and assets, the same scope Claude gets without asking. It used to run with the whole project writable and never asked, so it could change files such as package.json. If your own `~/.codex/config.toml` sets `sandbox_mode`, Codex keeps using that setting instead.
