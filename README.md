# Post-Mortem

A chess training web app that learns from your own chess.com games. Everything runs in your browser: no server, no account.

- **Games**: syncs your public chess.com games (or import PGN files).
- **Review**: Stockfish checks every move on your device, with verdicts, accuracy, arrows, an advantage graph and a game report.
- **Puzzles**: every mistake or blunder you make becomes a puzzle, with spaced repetition.
- **Openings**: your opening tree as White and Black, with the lines that need practice.
- **Prep**: scout an opponent before you play them.
- **Play**: practise against Stockfish at 7 levels, with feedback on every move.
- **Claude explanations**: copy a ready-made prompt for a Claude chat, or add your own Anthropic API key in Settings to stream answers into the app.

## Running it locally

```
python -m http.server 8077
```

Then open http://localhost:8077.

## For developers

The site is plain HTML, CSS and JavaScript with no build step. Third-party libraries live in `vendor/` and are refreshed with:

```
npm install
npm run vendor
```

Tests for the chess logic: `npm test`.

Libraries: [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0), [chessground](https://github.com/lichess-org/chessground) (GPL-3.0), [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause) and the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (MIT). Their licences are in `vendor/LICENSES.txt`.
