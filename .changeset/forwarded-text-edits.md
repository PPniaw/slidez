---
'@open-slide/core': patch
---

Text passed through more than one component (a layout handing `title` to a `Title`), or several props rendered in one element (`<p>{organ} {desc}</p>`), can now be edited on the slide; the edit lands on the literal the deck writes at the matching call. A save the editor can't place now explains why, in the user's language, instead of showing the internal reason.
