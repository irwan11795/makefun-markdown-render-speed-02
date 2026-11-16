# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/irwan11795/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/irwan11795/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for marked 18.1.3: it renders byte-identical HTML to `marked.parse(markdown)` with marked's default options (GFM on), for less CPU. The engine underneath is marked itself, vendored unchanged in `vendor/marked/` (MIT, see `vendor/marked/NOTICE`); `parse.js` drives marked's Lexer and Parser directly, skipping the `marked.parse` wrapper, and later versions add output-preserving fast paths on top of it. Every case is parsed from scratch — no caching between cases, no input recognition.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts
```

`main.ts` reads `<input-dir>/cases.json` (a JSON array of `{"id", "markdown"}`) and writes `<output-dir>/html.json` (a JSON array of the HTML strings, in the cases' order). Inside the grading container it runs as `node /bot/main.ts` and reads `/input/cases.json`, writing `/output/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2wht1jqa&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
