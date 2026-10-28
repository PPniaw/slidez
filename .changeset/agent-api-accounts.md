---
'@open-slide/core': minor
---

The agent panel signs Claude in with a pasted Anthropic API key, kept in a Claude config folder of its own, so it never runs on the Claude plan the user's own Claude Code is signed in with; a Claude plan sign-in there counts as signed out. A host app can set `OPEN_SLIDE_AGENT_API_ONLY=1` to sign Codex in with a pasted OpenAI API key the same way. The model menu gains a sign-out item. Conversations started under the old sign-in start over instead of failing.
