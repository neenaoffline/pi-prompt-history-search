# pi-prompt-history-search

A [pi](https://pi.dev/) extension that adds Claude Code-style reverse prompt history search to the interactive editor.

Press `Ctrl+R`, type part of an old prompt, and press `Enter` to restore it into the editor.

## Features

- `Ctrl+R` opens reverse prompt search in the main pi editor.
- Type to filter previous prompts by substring.
- Matching text is highlighted while reverse-search mode is active.
- `Ctrl+R` / `↑` cycles older matches.
- `Ctrl+S` / `↓` cycles newer matches.
- `Enter`, `Tab`, or `→` accepts the selected prompt.
- `Esc` or `Ctrl+C` cancels and restores the text you had before searching.
- Prompts are indexed across all saved sessions by default in `~/.pi/agent/prompt-history-index.jsonl`.
- Search scope is configurable: all sessions or only the current session.
- On first run, existing saved sessions are scanned to build the index.
- Existing user prompts from the current session are imported on startup.
- Includes `/prompt-history`, `/prompt-history-reindex`, and `/prompt-history-clear` commands.

## Installation

From GitHub:

```bash
pi install git:github.com/neenaoffline/pi-prompt-history-search
```

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
- `/prompt-history-reindex` — rebuild the prompt history index from saved sessions.
- `/prompt-history-clear` — delete the persisted history index.

## Configuration

By default, search spans all indexed user messages across saved sessions.

Set global config in `~/.pi/agent/prompt-history-search.json`, or project config in `.pi/prompt-history-search.json`:

```json
{
  "scope": "all"
}
```

Use `"scope": "current-session"` to search only the active session.
Project config overrides global config.

## Notes

- The index stores one JSONL record per prompt locally at `~/.pi/agent/prompt-history-index.jsonl`.
- The JSONL index is the only prompt-history index; if it does not exist, it is rebuilt from saved pi session JSONL files.
- The extension wraps any custom editor that was already configured; if none exists, it uses pi's `CustomEditor`.
- App-level shortcuts such as `Alt+Enter` follow-ups, model cycling, and tool expansion are forwarded while not in reverse-search mode.
- This package is marked `private` and `UNLICENSED` so it will not be accidentally published to npm. Change those fields before publishing.

## Development

Package layout:

```text
.
├── extensions/
│   └── prompt-history-search.ts
├── eslint.config.js
├── flake.nix
├── package.json
├── README.md
└── tsconfig.json
```

With Nix:

```bash
nix develop
npm install
npm run check
```

Without Nix, use Node.js 22+ and npm:

```bash
npm install
npm run check
```

Load locally during development:

```bash
pi --no-extensions -e ./extensions/prompt-history-search.ts --list-models
```

Or install the package directory:

```bash
pi install .
```
