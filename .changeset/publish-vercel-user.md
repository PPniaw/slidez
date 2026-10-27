---
'@open-slide/core': patch
---

The publish dialog no longer stretches past the screen when the Vercel CLI prints an update notice: the account name is read from `vercel whoami`'s stdout only, and a long name wraps instead of widening the dialog.
