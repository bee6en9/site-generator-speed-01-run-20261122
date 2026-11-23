// Faster drop-in for makefun-site 1.0.0: byte-identical output, faster CPU time.
//
// A single-file, dependency-free re-implementation of makefun-site's build:
// front matter, the Markdown subset, the template dialect, slugs, permalinks,
// tags, layouts and the build report. The behaviour is makefun-site's, read
// line by line from its code; the speed comes from fused passes and char-code
// scanners instead of per-line and per-character regular expressions:
//   - one split of each body (not one for the front matter and one for the lexer)
//   - inline rendering that scans plain runs and escapes them in bulk
//   - slugify with an ASCII fast path and a per-case memo, so the NFKD
//     normalisation only runs on non-ASCII text, once per distinct string
//   - templates compiled once per case into flat op arrays, rendered with
//     plain loops instead of recursive string concatenation per node
//   - cards, tag links and table-of-contents views built once per source
//     and shared by every template that reads them (templates only read)
//
// No cache is kept between cases: every run(input) builds its own memo maps.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);

// ---------------------------------------------------------------- text

/** HTML escape table, by character code (only & < > " ' are escaped). */
const ESC_CODE = [];
ESC_CODE[38] = '&amp;';
ESC_CODE[60] = '&lt;';
ESC_CODE[62] = '&gt;';
ESC_CODE[34] = '&quot;';
ESC_CODE[39] = '&#39;';

const MARK_RE = /\p{M}/gu;
const NON_ASCII = /[^\x00-\x7F]/;
const WS_RE = /\s/;
const SPEC_RE = /[\\`*[\]&<>"']/g;
const HTML_RE = /[&<>"']/g;
function escRepl(c) { return ESC_CODE[c.charCodeAt(0)]; }

/** `s` HTML-escaped, via one native scan (unchanged when nothing needs escaping). */
function escText(s) { return s.replace(HTML_RE, escRepl); }

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. `cache` memoises within one case.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let src = text;
  if (NON_ASCII.test(text)) src = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const out = [];
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out.push(n);
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out.push(c);
    }
    return { value: out.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (let p = 0; p < parts.length; p++) {
        const t = parts[p].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return raw.length === 0 ? { error: 'key "layout": not a template name' } : { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Scans lines by index so the body is never
 * split twice (the Markdown step splits it once).
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  if ((nl0 === -1 ? text : text.slice(0, nl0)) !== '---') return { error: 'no front matter' };
  // Find the closing line first: the baseline reports "not closed" before
  // any line error inside the front matter.
  let closeStart = -1;
  let closePos = -1;
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  while (pos <= text.length) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    if (eol - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closePos = eol === text.length ? text.length : eol + 1;
      break;
    }
    pos = eol === text.length ? text.length + 1 : eol + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = nl0 === -1 ? text.length : nl0 + 1;
  let lineNo = 1;
  while (pos < closeStart) {
    const eol = text.indexOf('\n', pos);
    const line = text.slice(pos, eol === -1 ? text.length : eol);
    lineNo++;
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: 'line ' + lineNo + ' is not "key: value"' };
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      raw = raw.slice(0, e);
      if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
      if (hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = eol === -1 ? text.length + 1 : eol + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closePos) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by character code. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;

/**
 * Whether position `k` is consumed as the second character of a backslash
 * escape when scanning `s` from `from` (the baseline's scan, replayed by
 * jumping between backslashes with indexOf instead of stepping per character).
 */
function isEscapedAt(s, from, k) {
  let b = from;
  for (;;) {
    b = s.indexOf('\\', b);
    if (b === -1 || b >= k) return false;
    if (b + 1 < s.length && isEscapable(s.charCodeAt(b + 1))) {
      if (b + 1 === k) return true;
      b += 2;
    } else b += 1;
  }
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    if (!isEscapedAt(s, from, k)) return k;
    j = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    if (isEscapedAt(s, from, k)) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/**
 * `s` rendered inline, appended to `out`. One native scan finds the next
 * construct starter (` \ ` * [) or HTML character (& < > " '); the plain
 * run before it holds none of either, so it is pushed raw, and each HTML
 * character is escaped as it is met — no second escaping pass over the
 * text. A starter whose construct does not close stays in the plain run
 * (only the scan position moves past it).
 */
function inlineInto(s, env, out) {
  const n = s.length;
  let runStart = 0;
  let scan = 0;
  let m;
  while (scan < n) {
    SPEC_RE.lastIndex = scan;
    m = SPEC_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (j > runStart) out.push(s.slice(runStart, j));
      out.push(ESC_CODE[c]);
      runStart = j + 1;
      scan = j + 1;
      continue;
    }
    if (c === 93) {
      scan = j + 1;
      continue;
    }
    if (c === 92) {
      if (j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push(s[j + 1]);
        runStart = j + 2;
        scan = j + 2;
        continue;
      }
      scan = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<code>' + escText(s.slice(j + 1, k)) + '</code>');
        runStart = k + 1;
        scan = k + 1;
        continue;
      }
      scan = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > runStart) out.push(s.slice(runStart, j));
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          runStart = k + 2;
          scan = k + 2;
          continue;
        }
        scan = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<em>');
        inlineInto(s.slice(j + 1, k), env, out);
        out.push('</em>');
        runStart = k + 1;
        scan = k + 1;
        continue;
      }
      scan = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    if (mm !== -1) {
      const target = s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<a href="' + escText(env.link(target)) + '">');
        inlineInto(s.slice(j + 1, k), env, out);
        out.push('</a>');
        runStart = mm + 1;
        scan = mm + 1;
        continue;
      }
    }
    scan = j + 1;
  }
  if (n > runStart) out.push(s.slice(runStart, n));
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  if (a === 0 && b === line.length) return line;
  return line.slice(a, b);
}

const isLangChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  if (line.charCodeAt(n) !== 32 && line.charCodeAt(n) !== 9) return null;
  let a = n;
  while (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9) a++;
  let b = line.length;
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  let p = -1;
  if (line.startsWith('---')) p = 3;
  else if (line.startsWith('***')) p = 3;
  else return false;
  for (let k = p; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let n = 0;
  while (n < 9 && line.charCodeAt(n) >= 48 && line.charCodeAt(n) <= 57) n++;
  if (n === 0) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { num: line.slice(0, n), rest: line.slice(n + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  return !WS_RE.test(line[j]);
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 * Lexing and rendering are fused into one pass over the lines.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || line.length === 0) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // A non-blank line opening on a space or tab is a paragraph (below).
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < L && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>');
        if (body.length > 0) out.push(escText(body.join('\n')), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const inner = [];
        inlineInto(h.text, env, inner);
        const html = inner.join('');
        out.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
      }
      const trimmed = [];
      for (let b = 0; b < body.length; b++) {
        const t = trimST(body[b]);
        if (t !== '') trimmed.push(t);
      }
      if (trimmed.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const inner = [];
        inlineInto(trimmed.join('\n'), env, inner);
        out.push('<blockquote>\n<p>' + inner.join('') + '</p>\n</blockquote>\n');
      }
      continue;
    }
    // A list item (a bullet or ordered marker), or a paragraph.
    let b = null;
    let o = null;
    if (c0 === 45 || c0 === 42) b = bulletOf(line);
    else if (c0 >= 48 && c0 <= 57) o = orderedOf(line);
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      const start = isOrdered ? Number(o.num) : 1;
      while (i < L) {
        const li = lines[i];
        const lc = li.charCodeAt(0);
        if (isOrdered) {
          if (lc >= 48 && lc <= 57) {
            const m = orderedOf(li);
            if (m !== null) {
              items.push([trimST(m.rest)]);
              i++;
              continue;
            }
          }
        } else if (lc === 45 || lc === 42) {
          const m = bulletOf(li);
          if (m !== null) {
            items.push([trimST(m)]);
            i++;
            continue;
          }
        }
        if (lc === 32 && isContinued(li)) {
          items[items.length - 1].push(trimST(li));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>');
      out.push('\n');
      for (let k = 0; k < items.length; k++) {
        const inner = [];
        inlineInto(items[k].join('\n'), env, inner);
        out.push('<li>' + inner.join('') + '</li>\n');
      }
      out.push('</' + tag + '>\n');
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < L && !endsPara(lines[i])) body.push(trimST(lines[i++]));
    const inner = [];
    inlineInto(body.join('\n'), env, inner);
    const html = inner.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const parts = text.split('.');
  for (let p = 0; p < parts.length; p++) {
    const seg = parts[p];
    if (seg.length === 0) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
    const c0 = seg.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
    for (let i = 1; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
    }
  }
  return parts;
}

// Token kinds: 0 text, 1 var, 2 raw, 3 tag. Op kinds: 0 text, 1 var, 2 raw,
// 3 for [3, name, path, body], 4 if [4, not, path, then, else|null],
// 5 include [5, name].

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  const N = src.length;
  let i = 0;
  let seg = 0;
  while (i < N) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === N - 1) {
      if (N > seg) tokens.push([0, src.slice(seg, N)]);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      i = open + 1;
      continue;
    }
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (open > seg) tokens.push([0, src.slice(seg, open)]);
      tokens.push([raw ? 2 : 1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      seg = i;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? N : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        standalone = false;
        break;
      }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          standalone = false;
          break;
        }
      }
    }
    const textEnd = standalone ? lineStart : open;
    if (textEnd > seg) tokens.push([0, src.slice(seg, textEnd)]);
    tokens.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? N : nl + 1) : end;
    seg = i;
  }
  return tokens;
}

/** `{% for x in path %}` parsed, or null. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  const c0 = tag.charCodeAt(4);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
  let j = 5;
  while (j < tag.length) {
    const c = tag.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) j++;
    else break;
  }
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const p = tag.slice(j + 4);
  if (p === '' || WS_RE.test(p)) return null;
  return { name: tag.slice(4, j), path: p };
}

/** `{% if [not] path %}` parsed, or null. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || WS_RE.test(rest)) return null;
  return { not, path: rest };
}

/** `{% include "name" %}` parsed, or null. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 12) return null;
  const nm = tag.slice(9, -1);
  if (nm.length === 0) return null;
  for (let i = 0; i < nm.length; i++) {
    const c = nm.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return nm;
}

/** `src` parsed into its tree of ops (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', node: null, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    const t = tok[0];
    if (t === 0) {
      body.push([0, tok[1]]);
      continue;
    }
    if (t === 1 || t === 2) {
      body.push([t, tok[1]]);
      continue;
    }
    const tag = tok[1];
    const top = stack[stack.length - 1];
    let m;
    if ((m = parseFor(tag)) !== null) {
      const node = [3, m.name, pathOf(name, m.path), []];
      body.push(node);
      stack.push({ kind: 'for', node, body: node[3] });
      body = node[3];
    } else if ((m = parseIf(tag)) !== null) {
      const node = [4, m.not, pathOf(name, m.path), [], null];
      body.push(node);
      stack.push({ kind: 'if', node, body: node[3] });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError('template "' + name + '": an else outside an if');
      top.node[4] = [];
      top.body = top.node[4];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = parseInclude(tag)) !== null) body.push([5, m]);
    else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `ops` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderOps(ops, scope, ctx, depth, out) {
  for (let n = 0; n < ops.length; n++) {
    const op = ops[n];
    switch (op[0]) {
      case 0:
        out.push(op[1]);
        break;
      case 1:
        out.push(escText(textOf(lookup(scope, op[1]))));
        break;
      case 2:
        out.push(textOf(lookup(scope, op[1])));
        break;
      case 3: {
        const xs = lookup(scope, op[2]);
        if (Array.isArray(xs)) {
          for (let k = 0; k < xs.length; k++) {
            const vars = {};
            vars[op[1]] = xs[k];
            vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
            renderOps(op[3], { vars, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case 4: {
        const v = truthy(lookup(scope, op[2]));
        const br = v !== op[1] ? op[3] : op[4];
        if (br !== null) renderOps(br, scope, ctx, depth, out);
        break;
      }
      case 5: {
        const t = ctx.templates.get(op[1]);
        if (t === undefined || depth >= 8) break;
        const mt = ctx.meta.get(op[1]);
        if (mt.isConst && mt.chain <= 7 - depth) {
          let s = ctx.constCache.get(op[1]);
          if (s === undefined) {
            const tmp = [];
            renderOps(t, scope, ctx, depth + 1, tmp);
            s = tmp.join('');
            ctx.constCache.set(op[1], s);
          }
          out.push(s);
        } else renderOps(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template JIT
//
// The interpreter (renderOps) walks an op array per render: a switch per op,
// a scope-chain lookup per path, and a fresh scope object (plus a `loop`
// object) per for-iteration. Across hundreds of pages that is tens of
// thousands of dispatches. The JIT compiles each template's op tree once per
// case into a plain function that pushes into an array (no ropes, so the
// output flattens exactly once at join, as the interpreter's does) and the
// renderer calls it. Paths resolve at compile time: a name bound by an
// enclosing for reads S.<name>, `loop` reads S.loop, a root name reads
// R.<name> unless a loop shadows it (checked with hasOwn), any other name
// reads S.<name> (a free name from an enclosing include, undefined when
// absent); later segments go through hop(), the own-property check lookup()
// does. A for reuses one scope object and one loop state per loop site,
// mutated per iteration and restored after the loop, so shadowing and nesting
// behave exactly as the interpreter's fresh objects do. Includes go through
// F.inc, which keeps the interpreter's rules (a missing template, or depth
// >= 8, renders nothing; a case-constant template renders once per case and
// is reused). Set USE_JIT false to fall back to the interpreter: the
// interpreter's code stays in this file, untouched.

const USE_JIT = false;

/** Own-property hop: the value of `k` on `v`, or undefined (as lookup()). */
function hop(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

/** `{{ path }}` written escaped, as renderOps case 1 does. */
function jitWriteEsc(out, v) {
  out.push(escText(textOf(v)));
}

/** `{{{ path }}}` written raw, as renderOps case 2 does. */
function jitWriteRaw(out, v) {
  out.push(textOf(v));
}

/** The include of a compiled template, with the interpreter's rules (case 5). */
function jitInclude(name, out, R, S, D, F) {
  if (D >= 8) return;
  const fn = F.fns.get(name);
  if (fn === undefined) return;
  const mt = F.meta.get(name);
  if (mt !== undefined && mt.isConst && mt.chain <= 7 - D) {
    let s = F.constCache.get(name);
    if (s === undefined) {
      const tmp = [];
      fn(tmp, R, S, D + 1, F);
      s = tmp.join('');
      F.constCache.set(name, s);
    }
    out.push(s);
    return;
  }
  fn(out, R, S, D + 1, F);
}

const JIT_ROOT_VARS = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

/** A path's JavaScript expression in compiled code (first segment from S/R, the rest via hop()). */
function jitPath(path, bound) {
  const first = path[0];
  let expr;
  if (first === 'loop') expr = 'S.loop';
  else if (bound.has(first)) expr = 'S.' + first;
  else if (JIT_ROOT_VARS.has(first)) expr = '(F.hasOwn(S,' + JSON.stringify(first) + ')?S.' + first + ':R.' + first + ')';
  else expr = 'S.' + first;
  for (let k = 1; k < path.length; k++) expr = 'F.hop(' + expr + ',' + JSON.stringify(path[k]) + ')';
  return expr;
}

/** An op tree's JavaScript source: statements pushing into `out`. */
function jitOps(ops, bound) {
  let src = '';
  for (const op of ops) {
    if (op[0] === 0) {
      src += 'out.push(' + JSON.stringify(op[1]) + ');';
    } else if (op[0] === 1) {
      src += 'F.wEsc(out,' + jitPath(op[1], bound) + ');';
    } else if (op[0] === 2) {
      src += 'F.wRaw(out,' + jitPath(op[1], bound) + ');';
    } else if (op[0] === 3) {
      const inner = new Set(bound);
      inner.add(op[1]);
      src += '{const __xs=' + jitPath(op[2], bound) + ';if(Array.isArray(__xs)){const __n=__xs.length;const __lp={index:0,first:false,last:false,length:__n};const __sv=S.' + op[1] + ';const __hv=F.hasOwn(S,' + JSON.stringify(op[1]) + ');const __sl=S.loop;const __hl=F.hasOwn(S,"loop");for(let __k=0;__k<__n;__k++){S.' + op[1] + '=__xs[__k];S.loop=__lp;__lp.index=__k+1;__lp.first=__k===0;__lp.last=__k===__n-1;' + jitOps(op[3], inner) + '}if(__hv){S.' + op[1] + '=__sv;}else{delete S.' + op[1] + ';}if(__hl){S.loop=__sl;}else{delete S.loop;}}}';
    } else if (op[0] === 4) {
      src += 'if(F.truthy(' + jitPath(op[2], bound) + ')!==' + (op[1] ? 'true' : 'false') + '){' + jitOps(op[3], bound) + '}';
      if (op[4] !== null) src += 'else{' + jitOps(op[4], bound) + '}';
    } else if (op[0] === 5) {
      src += 'F.inc(' + JSON.stringify(op[1]) + ',out,R,S,D,F);';
    }
  }
  return src;
}

/** An op tree compiled to a render function (out, R, S, D, F). */
function compileTemplate(ops) {
  return new Function('out', 'R', 'S', 'D', 'F', jitOps(ops, new Set()));
}

// ---------------------------------------------------------------- template reuse

/**
 * Per-case template metadata: whether a template's rendering depends only on
 * the case-constant values (site, tags, recent), and its longest include
 * chain (Infinity when the include graph cycles below it). A template that
 * is constant and shallow is rendered once per case and reused: its output
 * cannot depend on the scope it is included from (every name it reads is a
 * case constant or bound by its own for over a case-constant path), and the
 * chain bound keeps the include-depth cutoff from ever changing it.
 */
const CONST_ROOT = ['site', 'tags', 'recent'];

function analyzeTemplates(templates) {
  const meta = new Map();

  function chainOf(name, visiting) {
    const ops = templates.get(name);
    if (ops === undefined) return 0;
    if (visiting.has(name)) return Infinity;
    visiting.add(name);
    let m = 0;
    const walk = (list) => {
      for (const op of list) {
        if (op[0] === 5) {
          const r = chainOf(op[1], visiting);
          if (r === Infinity) m = Infinity;
          else if (m !== Infinity && 1 + r > m) m = 1 + r;
        } else if (op[0] === 3) walk(op[3]);
        else if (op[0] === 4) {
          walk(op[3]);
          if (op[4] !== null) walk(op[4]);
        }
      }
    };
    walk(ops);
    visiting.delete(name);
    return m;
  }

  function constOps(list, env, visiting) {
    for (const op of list) {
      switch (op[0]) {
        case 0:
          break;
        case 1:
        case 2:
          if (!env.has(op[1][0])) return false;
          break;
        case 3: {
          if (!env.has(op[2][0])) return false;
          const env2 = new Set(env);
          env2.add(op[1]);
          env2.add('loop');
          if (!constOps(op[3], env2, visiting)) return false;
          break;
        }
        case 4: {
          if (!env.has(op[2][0])) return false;
          if (!constOps(op[3], env, visiting)) return false;
          if (op[4] !== null && !constOps(op[4], env, visiting)) return false;
          break;
        }
        case 5:
          if (!constOf(op[1], visiting)) return false;
          break;
      }
    }
    return true;
  }

  function constOf(name, visiting) {
    const ops = templates.get(name);
    if (ops === undefined) return true;
    if (visiting.has(name)) return false;
    visiting.add(name);
    const ok = constOps(ops, new Set(CONST_ROOT), visiting);
    visiting.delete(name);
    return ok;
  }

  for (const name of templates.keys()) {
    meta.set(name, { isConst: constOf(name, new Set()), chain: chainOf(name, new Set()) });
  }
  return meta;
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  if (t.length < 2) return false;
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) continue;
    return false;
  }
  return false;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else if (c < 127) ws = false;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inW = false;
    else if (!inW) {
      inW = true;
      n++;
    }
  }
  return n;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push('refused ' + s.path + ": tags/ is the generator's own");
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push('refused ' + s.path + ": page/ is the generator's own");
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenSet = taken.get(dir);
    if (takenSet === undefined) {
      takenSet = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, takenSet);
    }
    s.slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, slugCache), takenSet);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, each source's body rendered to HTML, its links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add('broken-link ' + srcPath + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const names = p.data.tags !== undefined ? p.data.tags : [];
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: base + '/tags/' + slug + '/', posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const names = s.data.tags !== undefined ? s.data.tags : [];
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const t = bySlug.get(slug);
      s.tagRefs.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // One card, link record and table-of-contents view per source, shared by
  // every template that reads them (templates only read).
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: s.reading,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.tocView = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    s.link = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    };
  }

  // Layouts: every page through its layout, the index pages and the tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates, meta: analyzeTemplates(templates), constCache: new Map() };
  // The JIT's per-case table: each template compiled once, with the
  // interpreter's const analysis and cache shared (see the template JIT note).
  const F = USE_JIT
    ? {
        fns: new Map([...templates].map(([n, ops]) => [n, compileTemplate(ops)])),
        meta: ctx.meta,
        constCache: ctx.constCache,
        hop,
        truthy,
        wEsc: jitWriteEsc,
        wRaw: jitWriteRaw,
        inc: jitInclude,
        hasOwn,
      }
    : null;
  // One root scope per case, its varying keys rewritten per render (templates
  // only read during a render, so sharing it across renders is sound; a key
  // left undefined reads exactly as an absent one).
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, vars) => {
    if (USE_JIT) {
      const fn = F.fns.get(name);
      if (fn === undefined) return null;
      rootVars.page = undefined;
      rootVars.posts = undefined;
      rootVars.pager = undefined;
      rootVars.tag = undefined;
      for (const k in vars) rootVars[k] = vars[k];
      const out = [];
      fn(out, rootVars, {}, 0, F);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    rootVars.page = undefined;
    rootVars.posts = undefined;
    rootVars.pager = undefined;
    rootVars.tag = undefined;
    for (const k in vars) rootVars[k] = vars[k];
    const out = [];
    renderOps(nodes, rootScope, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.tocView,
      newer: s.newer ? s.newer.link : null,
      older: s.older ? s.older.link : null,
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
