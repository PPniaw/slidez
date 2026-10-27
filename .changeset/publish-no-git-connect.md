---
'@open-slide/core': patch
---

Publishing a deck from a project inside a git repository no longer connects the new Vercel project to that repository. Before, every push to the repository started a Vercel build that failed ("No Output Directory named public") and sent a failure email. Already connected projects stay connected; disconnect one with `vercel git disconnect` in its folder under `node_modules/.open-slide/publish/`.
