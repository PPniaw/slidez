---
'@open-slide/core': patch
---

Assets can move between a deck and the shared folder. Drag a deck asset onto the "Shared" tab, or pick "Move to shared" from its menu, and the deck's imports change from `./assets/<name>` to `@assets/<name>`; a shared asset moves back the same way. The move is refused, with the file and line, when a reference is not an import it can rewrite, when another deck uses the file, or while the agent is editing the deck. A different file with the same name is offered a free name, an identical one is reused, and the toast after a move offers Undo.
