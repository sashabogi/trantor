# A note's pins live in its front matter and fingerprint the symbol's body

A note's pins are a list in its own front matter, each naming a graft symbol and carrying a fingerprint of that symbol's body taken at pin time; a note goes stale when the fingerprint no longer matches, and broken when the symbol is gone. We chose a body fingerprint over the file's last commit date because any unrelated edit in the same file would flag the note, burying real staleness in noise, and we keep pins in the note rather than a side index so a note carries its own provenance wherever it is copied.

## Considered Options

- Last commit date of the pinned file: cheap, but flags on every unrelated edit in the file.
- A separate pin index beside the notes: keeps notes untouched, but the index and the notes can drift apart and a copied note loses its pins.
