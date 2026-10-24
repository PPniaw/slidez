---
'@open-slide/core': patch
---

Keep Vite's dependency cache in the workspace (`node_modules/.open-slide/vite`) instead of inside the installed package. A read-only install, such as a signed desktop app or a root-owned global install, no longer leaves the workspace on a blank page.
