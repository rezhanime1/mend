// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`. It applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE, V4A, JSON) to a tree of text files, all or nothing,
// finding the lines each edit names at the first of three whitespace-tolerance tiers.
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set: keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: three-tier line matching ----

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
/** Positions where old occurs in lines at one tier, in order. Occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (!lineEq(lines[i + k]!, old[k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function firstTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, old, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/**
 * Build the replacement lines for an occurrence at `at`: a context line is written as the
 * file's own matched line (ctxMap[j] is its index in the old lines, -1 when it is not one);
 * every other new line is re-indented at tier 2 from the old lines' first indent to the file's.
 */
function buildNew(fileLines: string[], at: number, oldL: string[], newL: string[], ctxMap: number[], tier: number): string[] {
  const out: string[] = [];
  const pfx = oldL.length > 0 ? leadingWS(oldL[0]!) : '';
  const ffx = leadingWS(fileLines[at] ?? '');
  for (let j = 0; j < newL.length; j++) {
    const cj = ctxMap[j]!;
    if (cj >= 0) { out.push(fileLines[at + cj]!); continue; }
    let l = newL[j]!;
    if (tier === 2 && l !== '' && l.trim() !== '' && l.startsWith(pfx)) l = ffx + l.slice(pfx.length);
    out.push(l);
  }
  return out;
}

/** A text file split into lines under its own break, with whether it ends in one. */
interface FileText { lines: string[]; br: string; endBreak: boolean; }
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', endBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endBreak = text.endsWith(br);
  const parts = text.split(br);
  if (endBreak) parts.pop();
  return { lines: parts, br, endBreak };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endBreak ? f.br : '');
}

// ---- Section 6: unified diffs ----

interface BodyItem { kind: 'ctx' | 'old' | 'new'; text: string; noNL: boolean; }
interface Hunk { start: number; items: BodyItem[]; }
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasDashPair: boolean;
  dashOldNull: boolean;
  dashNewNull: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
/** Path from a `--- ` / `+++ ` line: after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!;
  return raw.trim();
}
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's (or chunk's) old and new lines, with which new lines are context lines. */
function hunkON(items: BodyItem[]): { oldL: string[]; newL: string[]; ctxMap: number[] } {
  const oldL: string[] = [];
  const newL: string[] = [];
  const ctxMap: number[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') { oldL.push(it.text); newL.push(it.text); ctxMap.push(oi); oi += 1; }
    else if (it.kind === 'old') { oldL.push(it.text); oi += 1; }
    else { newL.push(it.text); ctxMap.push(-1); }
  }
  return { oldL, newL, ctxMap };
}
/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastNoNL(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.noNL;
  }
  return false;
}
/** Whether a `\` line follows the last `+` line of the section's hunks. */
function lastPlusNoNL(s: UniSection): boolean {
  for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
    const h = s.hunks[hi]!;
    for (let i = h.items.length - 1; i >= 0; i--) {
      if (h.items[i]!.kind === 'new') return h.items[i]!.noNL;
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file's lines. Throws Fail('no-match', path). */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { oldL, newL, ctxMap } = hunkON(h.items);
    if (oldL.length > 0) {
      const found = firstTier(f.lines, oldL, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.start - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const atEnd = best + oldL.length === f.lines.length;
      const rep = buildNew(f.lines, best, oldL, newL, ctxMap, found.tier);
      f.lines.splice(best, oldL.length, ...rep);
      if (atEnd) f.endBreak = !lastNoNL(h.items);
      d += newL.length - oldL.length;
    } else {
      const wasLen = f.lines.length;
      const at = Math.max(0, Math.min(h.start + d, wasLen));
      f.lines.splice(at, 0, ...newL);
      if (at === wasLen) f.endBreak = !lastNoNL(h.items);
      d += newL.length;
    }
  }
}

function resolveSection(s: UniSection): { oldP: string | null; newP: string | null; isCreate: boolean; isDelete: boolean } {
  const oldP = s.hasDashPair ? s.oldPath : (s.renameFrom !== undefined ? s.renameFrom : s.oldPath);
  const newP = s.hasDashPair ? s.newPath : (s.renameTo !== undefined ? s.renameTo : s.newPath);
  return { oldP, newP, isCreate: s.newFile || s.dashOldNull, isDelete: s.delFile || s.dashNewNull };
}

function uniEdit(s: UniSection, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    const { oldP, newP, isCreate, isDelete } = resolveSection(s);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNL(s) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = splitFile(before);
      applyHunks(f, s.hunks, strict, oldP);
      tree.now.set(newP, joinFile(f));
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    applyHunks(f, s.hunks, strict, p);
    tree.now.set(p, joinFile(f));
  };
}

function parseUnified(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headerDone = false;
  const finish = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    headerDone = false;
  };
  const startSection = (oldRaw: string | null, newRaw: string | null, fromPair: boolean): void => {
    cur = {
      oldPath: oldRaw === null || oldRaw === '/dev/null' ? null : stripAB(oldRaw),
      newPath: newRaw === null || newRaw === '/dev/null' ? null : stripAB(newRaw),
      hasDashPair: fromPair,
      dashOldNull: oldRaw === '/dev/null',
      dashNewNull: newRaw === '/dev/null',
      newFile: false,
      delFile: false,
      hunks: [],
    };
    headerDone = false;
  };
  /** Read one hunk at `at` (its header line). Returns the hunk and the next line index. */
  const readHunk = (at: number): { hunk: Hunk; next: number } => {
    const m = HUNK_HEAD.exec(lines[at]!);
    if (m === null) throw new Exit2(`error: parse ${at + 1}`);
    const start = Number(m[1]);
    const raw: string[] = [];
    let i = at + 1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        raw.push(l);
        i += 1;
      } else break;
    }
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    const items: BodyItem[] = [];
    for (const l of raw) {
      if (l.startsWith('\\')) {
        if (items.length > 0) items[items.length - 1]!.noNL = true;
      } else if (l === '') items.push({ kind: 'ctx', text: '', noNL: false });
      else items.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1), noNL: false });
    }
    return { hunk: { start, items }, next: i };
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      startSection(m[1]!, m[2]!, false);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(dashPath(l), dashPath(lines[i + 1]!), true);
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!headerDone) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const oldP = dashPath(l);
          const newP = dashPath(lines[i + 1]!);
          cur.oldPath = oldP === '/dev/null' ? null : stripAB(oldP);
          cur.newPath = newP === '/dev/null' ? null : stripAB(newP);
          cur.hasDashPair = true;
          cur.dashOldNull = oldP === '/dev/null';
          cur.dashNewNull = newP === '/dev/null';
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('@@')) {
        const h = readHunk(i);
        cur.hunks.push(h.hunk);
        headerDone = true;
        i = h.next;
        continue;
      }
      if (l.startsWith('rename from ')) { cur.renameFrom = l.slice(12).trim(); i += 1; continue; }
      if (l.startsWith('rename to ')) { cur.renameTo = l.slice(10).trim(); i += 1; continue; }
      if (l.startsWith('new file mode')) { cur.newFile = true; i += 1; continue; }
      if (l.startsWith('deleted file mode')) { cur.delFile = true; i += 1; continue; }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const h = readHunk(i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      finish();
      startSection(dashPath(l), dashPath(lines[i + 1]!), true);
      i += 2;
      continue;
    }
    i += 1;
  }
  finish();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, strict, moves));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = firstTier(f.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildNew(f.lines, at, oldL, newL, newL.map(() => -1), found.tier);
    f.lines.splice(at, oldL.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > boundary; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchNo}`);
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') { eq = k; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    boundary = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4Chunk { anchor: string | null; items: BodyItem[]; eof: boolean; }

const ADD_P = '*** Add File:';
const DEL_P = '*** Delete File:';
const UPD_P = '*** Update File:';
const MOV_P = '*** Move to:';

function isSectionStart(l: string): boolean {
  return l.startsWith(ADD_P) || l.startsWith(DEL_P) || l.startsWith(UPD_P);
}

function v4AddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}
function v4DeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
function v4UpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let idx = cursor; idx < f.lines.length; idx++) {
            if (lineEq(f.lines[idx]!, c.anchor, t)) { found = idx; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { oldL, newL, ctxMap } = hunkON(c.items);
      if (oldL.length > 0) {
        const tiers = strict ? [0] : [0, 1, 2];
        let hit: { tier: number; at: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(f.lines, oldL, t).filter((p) => p >= cursor);
          const good = c.eof ? occ.filter((p) => p + oldL.length === f.lines.length) : occ;
          if (good.length > 0) { hit = { tier: t, at: good[0]! }; break; }
        }
        if (hit === null) throw new Fail('no-match', path);
        const rep = buildNew(f.lines, hit.at, oldL, newL, ctxMap, hit.tier);
        f.lines.splice(hit.at, oldL.length, ...rep);
        cursor = hit.at + newL.length;
      } else {
        const at = c.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...newL);
        cursor = at + newL.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4A(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith(ADD_P)) {
      const path = l.slice(ADD_P.length).trim();
      let j = i + 1;
      const raw: string[] = [];
      while (j < last && !isSectionStart(lines[j]!)) { raw.push(lines[j]!); j += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.startsWith('+')) fileLines.push(r.slice(1));
        else if (r === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4AddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith(DEL_P)) {
      const path = l.slice(DEL_P.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push(v4DeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith(UPD_P)) {
      const path = l.slice(UPD_P.length).trim();
      const updNo = i + 1;
      let j = i + 1;
      const raw: string[] = [];
      while (j < last && !isSectionStart(lines[j]!)) { raw.push(lines[j]!); j += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.startsWith(MOV_P)) {
        moveTo = raw[k]!.slice(MOV_P.length).trim();
        k += 1;
      }
      const chunks: V4Chunk[] = [];
      let firstChunk = true;
      const bodyLine = (b: string): boolean => b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '';
      const takeChunk = (): { items: BodyItem[]; eof: boolean } => {
        const items: BodyItem[] = [];
        let eof = false;
        while (k < raw.length) {
          const b = raw[k]!;
          if (b.startsWith('@@')) break;
          if (b === '*** End of File') { eof = true; k += 1; break; }
          if (bodyLine(b)) {
            if (b === '') items.push({ kind: 'ctx', text: '', noNL: false });
            else items.push({ kind: b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : 'new', text: b.slice(1), noNL: false });
            k += 1;
          } else throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        return { items, eof };
      };
      while (k < raw.length) {
        const r = raw[k]!;
        const lineNo = i + 2 + k;
        if (r.startsWith('@@')) {
          const anchorText = r.slice(2).trim();
          const anchor = anchorText === '' ? null : anchorText;
          k += 1;
          const { items, eof } = takeChunk();
          chunks.push({ anchor, items, eof });
          firstChunk = false;
          continue;
        }
        if (firstChunk && bodyLine(r)) {
          const { items, eof } = takeChunk();
          chunks.push({ anchor: null, items, eof });
          firstChunk = false;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updNo}`);
      edits.push(v4UpdateEdit(path, moveTo, chunks, strict, moves));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 9: JSON edits ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 10: order, atomicity, output ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveByNew = new Map<string, string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) moveByNew.set(n, o);
  }
  const moveOlds = new Set(moveByNew.values());
  const rows: { key: string; text: string }[] = [];
  for (const [n, o] of moveByNew) rows.push({ key: n, text: `R ${o} -> ${n}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveByNew.has(p) || moveOlds.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
