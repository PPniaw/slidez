---
'@open-slide/core': patch
---

Published decks no longer carry speaker notes. `open-slide publish` empties the `notes` export in its staging copy before building, then scans the build and stops if any note text is still there. Your workspace keeps its notes. A presenter view opened from a published link explains that notes stay in the workspace. Decks published before this change still contain their notes until they are published again.
