---
'@open-slide/core': patch
---

The Codex agent no longer fails with "failed to load AGENTS.md instructions … Operation not permitted" when the project sits inside a git repository that has its own AGENTS.md. Codex now treats the project folder as its root, which its read permissions cover.
