---
'@open-slide/core': patch
---

Unpublishing a deck works again with Vercel CLI 65 (the one bundled with the slidez desktop app). That CLI only deletes a project with `--yes` when it has no terminal, so unpublishing failed with "Vercel 專案 … 還在". Older CLIs without `--yes` still get the answer on stdin.
