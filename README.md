# pi-prompt-history-search

A [pi](https://pi.dev/) extension that adds Claude Code-style reverse prompt history search to the interactive editor.

Press `Ctrl+R`, type part of an old prompt, and press `Enter` to restore it into the editor.

## Features

- `Ctrl+R` opens reverse prompt search in the main pi editor.
- Type to filter previous prompts by substring.
- `Ctrl+R` / `↑` cycles older matches.
- `Ctrl+S` / `↓` cycles newer matches.
- `Enter`, `Tab`, or `→` accepts the selected prompt.
- `Esc` or `Ctrl+C` cancels and restores the text you had before searching.
- Prompts are persisted across sessions in `~/.pi/agent/prompt-history.json`.
- Existing user prompts from the current session are imported on startup.
- Includes `/prompt-history` and `/prompt-history-clear` commands.

## Installation

From this local checkout:

```bash
pi install /home/neena/repos/neenaoffline/pi-prompt-history-search
```

Then restart pi, or run `/reload` in an existing pi session.

For one-off testing without installing:

```bash
pi --no-extensions -e /home/neena/repos/neenaoffline/pi-prompt-history-search --list-models
```

## Usage

In interactive pi:

1. Press `Ctrl+R`.
2. Type a few characters from a previous prompt.
3. Press `Ctrl+R` again to move to older matches, or `Ctrl+S` for newer matches.
4. Press `Enter` to accept, or `Esc` to cancel.

Slash commands:

- `/prompt-history` — choose a previous prompt from a selector and place it in the editor.
- `/prompt-history-clear` — delete the persisted history file.

## Notes

- The history file stores prompt text locally at `~/.pi/agent/prompt-history.json`.
- The extension wraps any custom editor that was already configured; if none exists, it uses pi's `CustomEditor`.
- This package is marked `private` and `UNLICENSED` so it will not be accidentally published. Change those fields before publishing.

## Development

Package layout:

```text
.
├── extensions/
│   └── prompt-history-search.ts
├── package.json
└── README.md
```

Load locally during development:

```bash
pi --no-extensions -e ./extensions/prompt-history-search.ts --list-models
```

Or install the package directory:

```bash
pi install .
```
