// main.ts — the program the harness runs for the markdown-render-speed-02 entry.
//
// It reads every case from /input/cases.json (or $MAKEFUN_INPUT_DIR outside a
// container), renders each case alone with parse() from parse.js, and writes
// /output/html.json (or $MAKEFUN_OUTPUT_DIR): a JSON array of the HTML strings,
// one per case, in the cases' order. Runs as `node /bot/main.ts` on Node 22.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// One read of the whole set, one JSON parse, then a render per case.
const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  markdown: string;
}[];

// Pre-size the output array so the loop only fills it, in order.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i]!.markdown);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
