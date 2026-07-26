# Third Mind Reader

> **Status:** beta (pre-1.0), distributed for testing via BRAT.
>
>**How this was built:** the code here is largely AI-generated and directed by me —
> [see below](#how-this-was-built).

An opinionated EPUB reader for Obsidian. It renders EPUBs with a character-precise
reading layout, a highlighting and annotation layer ("Gloss"), per-book companion
notes that live in your vault, and an optional inline AI librarian.

## Features

- Two-page spread and single-page reading with chapter / table-of-contents navigation.
- Highlight and Annotate books by selecting text.
- Per-book **companion notes** written into your vault, linked back to the source.
- Optional **AI librarian** for highlighting with four additional annotation modes (Exclaim, Explain, Examine, Enquiry) using a provider of your choice. Built for local models first.
- A Library view of all books in your vault with annotation status and progress.

## Install (beta, via BRAT)

1. Install the **BRAT** community plugin.
2. In BRAT, run **"Add a beta plugin for testing"** and enter this repository's path.
3. Enable **Third Mind Reader** in Community Plugins.
4. Open any `.epub` file in your vault to start reading.

## How this was built

The code in this repository is largely AI-generated. I directed it; architecture,
specs, review, and a lot of fine tuning. I wrote very little of the TypeScript by hand.

What I authored is the part I'm actually qualified for: the product and system design,
the interactions, the reading experience, and the design language underneath it.
Most features here started as a written spec before any code existed for them, and the
visual system predates the plugin entirely. While the implementation
is generated, the decisions are mine; as is the responsibility

I'm saying this up front because you should know it before installing something, and
in the spirit of FOSS, you should know how it was made.

What that means in practice:

- **I'm still learning** I understand how the codebase fits together,
  and that understanding has already fixed real bugs. I won't be as fast as a
  maintainer who wrote every line, but I intend to have the code get better as I go along.
- **Bug reports are genuinely useful.** I'd much rather hear about a problem than not.
- **Fork it.** It's AGPL-3.0. If you'd do this better, please do.

Building this plugin has given me a new appreciation for how professionals write software, and I'm
still working out what doing this properly looks like.


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
  Reader** (in your README or LICENSE) is appreciated. "Third Mind Reader" / "TMR" is a held name — please rename your fork, thanks.

## Contributing

Not looking for external contributions at the moment, but I encourage you to **fork and make your own version** if you'd like to really make the reader yours.
Suggestions and bug reports are welcome via issues and the feedback button in the plugin settings. If you're feeling really generous, you can buy me a cup of tea here: 

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/M7I223W2ID)
