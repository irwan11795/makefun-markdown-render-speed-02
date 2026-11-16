// parse.js — a faster drop-in for marked 18.1.3 (MIT).
//
// parse(markdown) returns exactly the HTML that marked 18.1.3's
// marked.parse(markdown) returns with marked's default options (GFM on, breaks
// off, pedantic off, async off), for every string.
//
// HOW IT IS FASTER:
//  1. It skips marked.parse()'s wrapper entirely and calls the Lexer and the
//     Parser directly, on one shared options object. The Tokenizer and the
//     Renderer are created once, by the first call, and then reused: both are
//     stateless between parses (the Lexer owns the tokens, the inline queue
//     and the parse state; the Parser owns the output), so sharing them
//     changes no output.
//  2. Its Tokenizer overrides inlineText with an indexOf-based scan that
//     finds exactly where marked's GFM inline-text regex would stop, without
//     running that regex. The regex is a lazy scan with a lookahead evaluated
//     at every character; the replacement finds the same stop with a handful
//     of memchr-style searches (one sticky regex for the special characters,
//     then bounded indexOf searches for hard breaks, protocols, www., emails
//     and mailto:/xmpp:). Any chunk containing '&' falls back to marked's own
//     inlineText, so entity decoding is never reimplemented.
// Nothing is cached between calls: every parse still lexes and renders its
// input from scratch, and parse keeps no state.
//
// CREDIT: the engine underneath is marked 18.1.3, vendored unchanged in
// vendor/marked/marked.esm.js (MIT, Copyright (c) 2018-2026 MarkedJS;
// Copyright (c) 2011-2018 Christopher Jeffrey) with its LICENSE and NOTICE.
// This file only drives it through its public Lexer/Parser/Tokenizer
// classes, plus a Tokenizer subclass that re-implements one method.

import { Lexer, Parser, Tokenizer } from './vendor/marked/marked.esm.js';

// marked's defaults, as one object this module owns. The Lexer fills in
// `tokenizer` and the Parser fills in `renderer` on the first call; after
// that both are reused, and no per-call allocation of either happens.
const OPTIONS = {
  async: false,
  breaks: false,
  extensions: null,
  gfm: true,
  hooks: null,
  pedantic: false,
  renderer: null,
  silent: false,
  tokenizer: null,
  walkTokens: null,
};

// ---------------------------------------------------------------------------
// Fast inline-text scan.
//
// This finds the length of the prefix of `src` that marked's GFM inline
// `text` rule matches, i.e. the longest run the inline lexer emits as one
// text token. The regex stops at the earliest of:
//   (a) a special character: \ < ! [ ` * ~ _
//   (b) a hard break: a non-space character followed by two or more spaces
//       and a newline (the text ends right after that character)
//   (c) a protocol: bare http/https (any case), or ftp://
//   (d) www. whose previous character is the start, whitespace, *, _, ~ or (
//   (e) the start of an email-character run that ends at '@' (the run must
//       be non-empty: the stop is the run's start, or the first character
//       when the run starts before it)
//   (f) mailto:/xmpp: preceded by a non-alphanumeric character (or at
//       position 1 with a non-alphanumeric first character)
// The first character (or the opening run of ` or ~) is always included.
// ---------------------------------------------------------------------------

/** Next special character at or after `from`, or -1. One regex, reused. */
const SPECIAL_RE = /[\\<!\[`*~_]/g;
/** Bare http/https, any case (the regex stops before them with no ://), or ftp://. */
const HTTP_RE = /http|ftp:\/\//gi;

function isEmailCode(code) {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 46 || // .
    code === 33 || // !
    code === 35 || // #
    code === 36 || // $
    code === 37 || // %
    code === 38 || // &
    code === 39 || // '
    code === 42 || // *
    code === 43 || // +
    code === 47 || // /
    code === 61 || // =
    code === 63 || // ?
    code === 96 || // `
    code === 123 || // {
    code === 124 || // |
    code === 125 || // }
    code === 126 || // ~
    code === 45 || // -
    code === 95 // _
  );
}

function isAlnumCode(code) {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  );
}

function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

/** Length of the GFM inline-text match at the start of `src`. */
function scanTextEnd(src) {
  // The first character (or the opening run of ` or ~) is always consumed.
  let i = 0;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) {
    while (i < src.length && src.charCodeAt(i) === 96) i++;
  } else if (c0 === 126) {
    while (i < src.length && src.charCodeAt(i) === 126) i++;
  } else {
    i = 1;
  }
  const n = src.length;

  // (a) Next special character.
  SPECIAL_RE.lastIndex = i;
  const sm = SPECIAL_RE.exec(src);
  let end = sm ? sm.index : n;

  // Every other pattern only matters before `end`: slice once (a slice is
  // O(1) and copies nothing) and search inside it.
  const sub = src.slice(i, end);

  // (b) Hard-break boundary: the first "  \n"; walk back over its spaces.
  const k = sub.indexOf('  \n');
  if (k !== -1) {
    let s = k;
    while (s > 0 && sub.charCodeAt(s - 1) === 32) s--;
    const b = i + s;
    if (b < end) end = b < i ? i : b;
  }

  // (c) Bare http/https, then ftp://. Only a match starting before `end`
  // matters, so search inside the slice, not the whole remainder.
  HTTP_RE.lastIndex = 0;
  const hm = HTTP_RE.exec(sub);
  if (hm && i + hm.index < end) end = i + hm.index;

  // (d) www. with a permitted preceding character.
  let w = sub.indexOf('www.');
  while (w !== -1) {
    const p0 = i + w;
    const prev = src.charCodeAt(p0 - 1);
    if (isSpaceCode(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40) {
      if (p0 < end) end = p0;
      break;
    }
    w = sub.indexOf('www.', w + 4);
  }

  // (e) Email run start before an '@'. An '@' whose run is empty gives no
  // stop; a later '@' may still give one, so walk every '@' in order and
  // take the first valid stop — stops only grow with the '@' position.
  let atIdx = -1;
  while ((atIdx = sub.indexOf('@', atIdx + 1)) !== -1) {
    const aPos = i + atIdx;
    let s = aPos;
    while (s > 0 && isEmailCode(src.charCodeAt(s - 1))) s--;
    const stop = s < i ? i : s;
    if (stop < aPos) {
      if (stop < end) end = stop;
      break;
    }
  }
  // An email run may cross `end` when the character there is itself an
  // email character (!, `, *, ~, _): scan forward over email characters
  // from `end` and walk back if '@' is reached.
  if (end < n && isEmailCode(src.charCodeAt(end))) {
    let a = end;
    while (a < n && isEmailCode(src.charCodeAt(a))) a++;
    if (a < n && src.charCodeAt(a) === 64) {
      let s = a;
      while (s > 0 && isEmailCode(src.charCodeAt(s - 1))) s--;
      const stop = s < i ? i : s;
      if (stop < a && stop < end) end = stop;
    }
  }

  // (f) mailto:/xmpp: stops: the outer alternative (a non-alphanumeric
  // character at 0 followed by mailto: at 1) ends the match at 1; the inner
  // alternative consumes the non-alphanumeric character at p = q-1, so it
  // needs q-1 >= i, i.e. q >= i+1.
  for (const word of ['mailto:', 'xmpp:']) {
    let q = sub.indexOf(word, 0);
    while (q !== -1) {
      const p0 = i + q;
      if (p0 === 1 && !isAlnumCode(src.charCodeAt(0))) {
        if (p0 < end) end = p0;
        break;
      }
      if (p0 >= i + 1 && !isAlnumCode(src.charCodeAt(p0 - 1))) {
        if (p0 < end) end = p0;
        break;
      }
      q = sub.indexOf(word, q + 1);
    }
  }

  return end;
}

/** Expand tabs in `str` to spaces, counting columns from `startCol`. */
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const r = 4 - (col % 4);
      out += '    '.slice(0, r);
      col += r;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/**
 * `line` with its leading tabs expanded (columns counted from `startCol`),
 * or the line itself when its leading whitespace holds no tab.
 */
function expandLeadingTabs(line, startCol = 0) {
  let i = 0;
  let hasTab = false;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) i++;
    else if (c === 9) {
      hasTab = true;
      i++;
    } else break;
  }
  if (!hasTab) return line;
  return expandTabs(line.slice(0, i), startCol) + line.slice(i);
}

/** Index of the first character of `str` that is not a space, or -1. */
function firstNonSpace(str) {
  let p = 0;
  while (p < str.length && str.charCodeAt(p) === 32) p++;
  return p < str.length ? p : -1;
}

/** `str` up to its first newline (or all of it). */
function firstLine(str) {
  const nl = str.indexOf('\n');
  return nl === -1 ? str : str.slice(0, nl);
}

/** marked's Tokenizer with faster inlineText and list, same tokens. */
class FastTokenizer extends Tokenizer {
  inlineText(src) {
    const end = scanTextEnd(src);
    if (end === 0) return super.inlineText(src);
    const run = src.slice(0, end);
    // '&' means entities may need decoding: let marked do it.
    if (run.includes('&')) return super.inlineText(src);
    const inRawBlock = this.lexer.state.inRawBlock;
    // Without '&', marked's entity pass leaves the run unchanged, and in a
    // raw block the text is the raw run either way.
    return { type: 'text', raw: run, text: run, escaped: inRawBlock };
  }

  // First-character guards for the inline tokenizers the #t loop tries
  // before inlineText: each one's regex is anchored and needs a specific
  // first character, so a chunk starting with anything else cannot match
  // and the regex is never run. emStrong and del are NOT overridden: the
  // Lexer decides whether to mask the source by comparing those two methods
  // with marked's own, and overriding them would force the masking pass on
  // every inline source.
  escape(src) {
    return src.charCodeAt(0) === 92 ? super.escape(src) : undefined;
  }

  tag(src) {
    return src.charCodeAt(0) === 60 ? super.tag(src) : undefined;
  }

  link(src) {
    const c0 = src.charCodeAt(0);
    return c0 === 91 || c0 === 33 ? super.link(src) : undefined;
  }

  reflink(src, links) {
    const c0 = src.charCodeAt(0);
    return c0 === 91 || c0 === 33 ? super.reflink(src, links) : undefined;
  }

  codespan(src) {
    return src.charCodeAt(0) === 96 ? super.codespan(src) : undefined;
  }

  br(src) {
    const c0 = src.charCodeAt(0);
    return c0 === 32 || c0 === 92 ? super.br(src) : undefined;
  }

  autolink(src) {
    return src.charCodeAt(0) === 60 ? super.autolink(src) : undefined;
  }

  url(src) {
    const c0 = src.charCodeAt(0);
    return isAlnumCode(c0) || c0 === 46 || c0 === 95 || c0 === 43 || c0 === 45
      ? super.url(src)
      : undefined;
  }

  // marked's list tokenizer, with two cheap guards that change no token:
  //  - the six block-start tests in the inner loop run only when the line's
  //    first non-space character can start a fence, heading, html block,
  //    blockquote, bullet or hr (backtick, tilde, #, <, >, *, +, -, _ or a
  //    digit); any other first character fails all six.
  //  - leading-tab expansion is skipped when the leading whitespace holds
  //    no tab, and line splitting uses indexOf instead of split.
  list(src) {
    const block = this.rules.block;
    const other = this.rules.other;
    let t = block.list.exec(src);
    if (!t) return undefined;
    const n = src;
    let e = src;
    const s = () => n.length - e.length;
    const r0 = t[1].trim();
    const ordered = r0.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +r0.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    let r = ordered ? `\\d{1,9}\\${r0.slice(-1)}` : `\\${r0}`;
    if (this.options.pedantic) r = ordered ? r : '[*+-]';
    const itemRe = other.listItemRegex(r);
    let p = false;
    for (; e; ) {
      let u = false;
      let d = '';
      if (!(t = itemRe.exec(e)) || block.hr.test(e)) break;
      const k = s();
      e = e.substring(t[0].length);
      const g = firstLine(t[2]);
      const b = t[1].length;
      let m = this.options.pedantic ? expandTabs(g, b) : expandLeadingTabs(g, b);
      let f = firstLine(e);
      let y = !m.trim();
      let R = 0;
      if (this.options.pedantic) {
        R = 2;
        d = m.trimStart();
      } else if (y) {
        R = b + 1;
      } else {
        R = firstNonSpace(m);
        if (R > 4) R = 1;
        d = m.slice(R);
        R += b;
      }
      if (y && other.blankLine.test(f)) {
        e = e.substring(f.length + 1);
        u = true;
      }
      if (!u) {
        const v = other.nextBulletRegex(R);
        const Q = other.hrRegex(R);
        const ee = other.fencesBeginRegex(R);
        const te = this.options.pedantic
          ? other.pedanticHeadingBeginRegex(R)
          : other.headingBeginRegex(R);
        const M = other.htmlBeginRegex(R);
        const ne = other.blockquoteBeginRegex(R);
        for (; e; ) {
          const U = firstLine(e);
          let Z;
          f = U;
          if (this.options.pedantic) {
            f = f.replace(other.listReplaceNesting, '  ');
            Z = f;
          } else {
            Z = expandLeadingTabs(f, 0);
          }
          let fc = 0;
          while (fc < f.length && f.charCodeAt(fc) === 32) fc++;
          const fc0 = fc < f.length ? f.charCodeAt(fc) : -1;
          const mayStart =
            fc0 === 96 ||
            fc0 === 126 ||
            fc0 === 35 ||
            fc0 === 60 ||
            fc0 === 62 ||
            fc0 === 42 ||
            fc0 === 43 ||
            fc0 === 45 ||
            fc0 === 95 ||
            (fc0 >= 48 && fc0 <= 57);
          if (
            mayStart &&
            (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f))
          ) {
            break;
          }
          if (firstNonSpace(Z) >= R || !f.trim()) {
            d += '\n' + Z.slice(R);
          } else {
            if (
              y ||
              firstNonSpace(m.replace(other.tabCharGlobal, '    ')) >= 4 ||
              ee.test(m) ||
              te.test(m) ||
              M.test(m) ||
              Q.test(m)
            ) {
              break;
            }
            const qe =
              !this.options.pedantic &&
              /^ {0,3}(?:=+|-+) *$/.test(f) &&
              block.lheading.test(`${m}\n${f}`)
                ? `    ${Z.replace(/^ {0,3}/, '')}`
                : f;
            d += '\n' + qe;
          }
          y = !f.trim();
          e = e.substring(U.length + 1);
          m = Z.slice(R);
        }
      }
      const A = n.slice(k, s());
      if (!list.loose) {
        if (p) list.loose = true;
        else if (other.doubleBlankLine.test(A)) p = true;
      }
      list.items.push({
        type: 'list_item',
        raw: A,
        task: !!this.options.gfm && other.listIsTask.test(d),
        loose: false,
        text: d,
        tokens: [],
      });
    }
    const h = list.items.at(-1);
    if (h) {
      h.raw = h.raw.trimEnd();
      h.text = h.text.trimEnd();
    } else {
      return undefined;
    }
    list.raw = n.slice(0, s()).trimEnd();
    for (const u of list.items) {
      this.lexer.state.top = false;
      u.tokens = this.lexer.blockTokens(u.text, []);
      if (!list.loose) {
        const d = u.tokens.filter((g) => g.type === 'space');
        const k = d.length > 0 && d.some((g) => other.anyLine.test(g.raw));
        list.loose = k;
      }
    }
    for (const u of list.items) {
      const d = u.tokens[0];
      if (u.task && (d?.type === 'text' || d?.type === 'paragraph')) {
        u.text = u.text.replace(other.listReplaceTask, '');
        d.raw = d.raw.replace(other.listReplaceTask, '');
        d.text = d.text.replace(other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(
              other.listReplaceTask,
              ''
            );
            break;
          }
        }
        const k = other.listTaskCheckbox.exec(u.raw);
        if (k) {
          const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
          u.checked = g.checked;
          if (list.loose) {
            if (
              u.tokens[0] &&
              ['paragraph', 'text'].includes(u.tokens[0].type) &&
              'tokens' in u.tokens[0] &&
              u.tokens[0].tokens
            ) {
              u.tokens[0].raw = g.raw + u.tokens[0].raw;
              u.tokens[0].text = g.raw + u.tokens[0].text;
              u.tokens[0].tokens.unshift(g);
            } else {
              u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
            }
          } else {
            u.tokens.unshift(g);
          }
        }
      } else if (u.task) {
        u.task = false;
      }
    }
    if (list.loose) {
      for (const u of list.items) {
        u.loose = true;
        for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
      }
    }
    return list;
  }
}

OPTIONS.tokenizer = new FastTokenizer();

/**
 * marked's Lexer, with a first-character dispatch in blockTokens: most block
 * tokenizers need a specific first character, so for a block that starts at
 * column 0 only the ones that can match are tried (a table, a setext
 * heading, a paragraph or plain text can start with any character, so those
 * are always tried). Indented lines keep the full sequence. Nothing else
 * about blockTokens changes.
 */
class FastLexer extends Lexer {
  lex(src) {
    // The base lex() normalises CRLF/CR to LF; skip that scan when the
    // input holds no carriage return at all.
    if (!src.includes('\r')) {
      this.blockTokens(src, this.tokens);
      for (let t = 0; t < this.inlineQueue.length; t++) {
        const n = this.inlineQueue[t];
        this.state.inRawBlock = false;
        this.inlineTokens(n.src, n.tokens);
      }
      this.inlineQueue = [];
      return this.tokens;
    }
    return super.lex(src);
  }

  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this;
    if (this.options.pedantic) {
      e = e
        .replace(this.rules.other.tabCharGlobal, '    ')
        .replace(this.rules.other.spaceLine, '');
    }
    let s = Infinity;
    for (; e; ) {
      if (e.length < s) {
        s = e.length;
      } else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (
        this.options.extensions?.block?.some((i) =>
          (r = i.call({ lexer: this }, e, t))
            ? ((e = e.substring(r.raw.length)), t.push(r), true)
            : false
        )
      ) {
        continue;
      }
      // Dispatch on the first character (column-0 blocks only).
      const c0 = e.charCodeAt(0);
      let trySpace = true;
      let tryCode = true;
      let tryFences = true;
      let tryHeading = true;
      let tryHr = true;
      let tryBlockquote = true;
      let tryList = true;
      let tryHtml = true;
      let tryDef = true;
      if (c0 !== 32 && c0 !== 9) {
        trySpace = c0 === 10;
        tryCode = false;
        tryFences = c0 === 96 || c0 === 126;
        tryHeading = c0 === 35;
        tryHr = c0 === 45 || c0 === 95 || c0 === 42;
        tryBlockquote = c0 === 62;
        tryList = c0 === 42 || c0 === 43 || c0 === 45 || (c0 >= 48 && c0 <= 57);
        tryHtml = c0 === 60;
        tryDef = c0 === 91;
        // table and lheading stay enabled: their first line can start
        // with any character, as can paragraph and text.
      }
      if (trySpace && (r = this.tokenizer.space(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (r.raw.length === 1 && i !== undefined) i.raw += '\n';
        else t.push(r);
        continue;
      }
      if (tryCode && (r = this.tokenizer.code(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.at(-1).src = i.text;
        } else {
          t.push(r);
        }
        continue;
      }
      if (tryFences && (r = this.tokenizer.fences(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if (tryHeading && (r = this.tokenizer.heading(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if (tryHr && (r = this.tokenizer.hr(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if (tryBlockquote && (r = this.tokenizer.blockquote(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if (tryList && (r = this.tokenizer.list(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if (tryHtml && (r = this.tokenizer.html(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if (tryDef && (r = this.tokenizer.def(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.raw;
          this.inlineQueue.at(-1).src = i.text;
        } else {
          this.tokens.links[r.tag] ||
            (this.tokens.links[r.tag] = { href: r.href, title: r.title });
          t.push(r);
        }
        continue;
      }
      if ((r = this.tokenizer.table(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      if ((r = this.tokenizer.lheading(e))) {
        e = e.substring(r.raw.length);
        t.push(r);
        continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let i = Infinity;
        const l = e.slice(1);
        let p;
        this.options.extensions.startBlock.forEach((h) => {
          p = h.call({ lexer: this }, l);
          if (typeof p === 'number' && p >= 0) i = Math.min(i, p);
        });
        if (i < Infinity && i >= 0) o = e.substring(0, i + 1);
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        const i = t.at(-1);
        if (n && i?.type === 'paragraph') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = i.text;
        } else {
          t.push(r);
        }
        n = o.length !== e.length;
        e = e.substring(r.raw.length);
        continue;
      }
      if ((r = this.tokenizer.text(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = i.text;
        } else {
          t.push(r);
        }
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return t;
  }
}

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const tokens = new FastLexer(OPTIONS).lex(markdown);
  return Parser.parse(tokens, OPTIONS);
}
