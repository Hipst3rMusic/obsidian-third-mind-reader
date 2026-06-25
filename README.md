# Third Mind Reader

> **Status:** beta (pre-1.0), distributed for testing via BRAT.

An opinionated EPUB reader for Obsidian. It renders EPUBs with a character-precise
reading layout, a highlighting and annotation layer ("Gloss"), per-book companion
notes that live in your vault, and an optional inline AI librarian.

## Features

- Two-page spread and single-page reading with chapter / table-of-contents navigation.
- Highlighting with five annotation modes (Exclaim, Explain, Examine, Emphasise, Enquiry).
- Per-book **companion notes** written into your vault, linked back to the source.
- Optional **AI librarian** for Explain / Examine / Enquiry, using a provider you configure.
- A Library view of all books in your vault with annotation status.

## Install (beta, via BRAT)

1. Install the **BRAT** community plugin.
2. In BRAT, run **"Add a beta plugin for testing"** and enter the repository path.
3. Enable **Third Mind Reader** in Community Plugins.
4. Open any `.epub` file in your vault to start reading.

## Requirements & disclosures

- **Desktop only** for now. The EPUB-import feature uses Node/Electron APIs that
  aren't available on mobile.
- **Network use (optional).** AI features send the text you select plus your prompt
  to the AI provider you configure — Anthropic, OpenAI, or a local server such as
  Ollama or LM Studio. **No network request is made unless you actively use an AI
  feature.** There is no telemetry and no advertising.
- **API key / account.** Cloud AI requires your own API key, entered in settings and
  stored in Obsidian's encrypted secret storage. Local models need no key.
- **Your data.** Highlights and annotations are written to companion notes in your
  vault (under `Library/Annotations/`). The reader does not modify the source EPUB.

## Credits & licensing

- Licensed under **AGPL-3.0-or-later** — see [LICENSE](LICENSE).
- Built on: [jszip](https://stuk.github.io/jszip/) (MIT),
  [@chenglou/pretext](https://github.com/chenglou/pretext) (MIT),
  [DOMPurify](https://github.com/cure53/DOMPurify) (MPL-2.0 / Apache-2.0).
- Bundled fonts: Rosarivo, Labrada, Kode Mono (SIL Open Font License).
- If you build your own reader on top of this code, a one-line credit to **Third Mind
  Reader** (in your README or LICENSE) is appreciated. "Third Mind Reader" / "TMR" is
  a held name — please rename your fork.

## Contributing

Not looking for external contributions at the moment — please **fork and release your own version**.
Suggestions and bug reports are welcome via issues.
