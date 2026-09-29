/* Wordy core logic: parsing, scheduling, matching. No DOM access here so it can be tested in Node. */
const Logic = (() => {
  const DAY = 86400000;
  const MIN = 60000;

  /* ---------- Import / parsing ---------- */
  // Accepts:  "# Vocabulary Set: 2026"  headers  +  "12. term - definition" lines
  // (hyphen, en dash or em dash; tab or space before the dash; numbering optional)
  // Also accepts "term | definition" and "term<TAB>definition".
  function parseVocab(text, defaultSet = 'Imported') {
    const out = [];
    let set = defaultSet;
    const lines = text.replace(/\r/g, '').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const h = line.match(/^#+\s*(?:vocabulary\s*set\s*[:\-–—]?\s*)?(.+)$/i);
      if (h) { set = h[1].trim(); continue; }
      let m = line.match(/^(?:\d+\s*[.)]\s*)?(.+?)\s*\|\s*(.+)$/);
      if (!m) m = line.match(/^(?:\d+\s*[.)]\s*)?(.+?)\t+\s*(.+)$/);
      if (!m) m = line.match(/^(?:\d+\s*[.)]\s*)?(.+?)\s*[–—-]\s+(.+)$/);
      if (!m) continue;
      const term = m[1].trim().replace(/\s+/g, ' ');
      const def = m[2].trim().replace(/^[–—-]\s*/, '').replace(/\s+/g, ' ');
      if (term && def) out.push({ set, term, def });
    }
    return out;
  }

  const keyOf = (set, term) => (set + '||' + term).toLowerCase();

  function newCard(p) {
    return {
      id: keyOf(p.set, p.term), set: p.set, term: p.term, def: p.def,
      ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0,
      seen: 0, correct: 0, streak: 0, last: 0, hist: [],
      modes: {}, ai: null
    };
  }

  // Merge parsed pairs into existing cards; progress is kept when the term already exists.
  function mergeImport(cards, parsed) {
    const map = new Map(cards.map(c => [c.id, c]));
    let added = 0, updated = 0, same = 0;
    for (const p of parsed) {
      const id = keyOf(p.set, p.term);
      const c = map.get(id);
      if (!c) { map.set(id, newCard(p)); added++; }
      else if (c.def !== p.def) { c.def = p.def; c.ai = null; updated++; }
      else same++;
    }
    return { cards: [...map.values()], added, updated, same };
  }

  /* ---------- Scheduling (SM-2 flavored) ---------- */
  // grade: 0 again, 1 hard, 2 good, 3 easy
  function review(card, grade, mode = 'flash', now = Date.now()) {
    const c = card;
    c.seen++; c.last = now;
    const ok = grade >= 1;
    if (ok) { c.correct++; c.streak++; } else { c.streak = 0; }
    const m = c.modes[mode] || (c.modes[mode] = { n: 0, ok: 0 });
    m.n++; if (ok) m.ok++;
    c.hist.push(ok ? 1 : 0); if (c.hist.length > 12) c.hist.shift();

    if (grade === 0) {
      c.lapses++; c.reps = 0;
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.interval = 0;
      c.due = now + 10 * MIN;
    } else {
      c.reps++;
      if (grade === 1) c.ease = Math.max(1.3, c.ease - 0.15);
      if (grade === 3) c.ease += 0.15;
      let days;
      if (c.reps === 1) days = grade === 3 ? 3 : 1;
      else if (c.reps === 2) days = grade === 3 ? 6 : 3;
      else {
        const mult = grade === 1 ? 1.2 : grade === 3 ? c.ease * 1.3 : c.ease;
        days = Math.max(c.interval + 1, Math.round(c.interval * mult));
      }
      c.interval = days;
      c.due = now + days * DAY;
    }
    return c;
  }

  function stateOf(c, now = Date.now()) {
    if (c.seen === 0) return 'new';
    if (c.interval >= 21) return 'mastered';
    if (c.reps <= 1 && c.interval < 3) return 'learning';
    return 'reviewing';
  }
  const isDue = (c, now = Date.now()) => c.seen > 0 && c.due <= now;
  const accuracy = c => (c.seen ? c.correct / c.seen : null);
  function isWeak(c) {
    if (c.seen < 2) return false;
    const recent = c.hist.slice(-5);
    const rAcc = recent.reduce((a, b) => a + b, 0) / recent.length;
    return c.lapses >= 2 || rAcc < 0.6;
  }
  function weakScore(c) {
    const recent = c.hist.slice(-6);
    const misses = recent.length - recent.reduce((a, b) => a + b, 0);
    return c.lapses * 2 + misses;
  }

  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // "smart" queue: due first, then weak, then new. size = session length.
  function buildQueue(pool, size = 20, opts = {}) {
    const now = Date.now();
    const due = shuffle(pool.filter(c => isDue(c, now))).sort((a, b) => a.due - b.due);
    const weak = shuffle(pool.filter(c => isWeak(c) && !isDue(c, now)));
    const fresh = shuffle(pool.filter(c => c.seen === 0));
    const rest = shuffle(pool.filter(c => c.seen > 0 && !isDue(c, now) && !isWeak(c)));
    let q = [];
    const push = arr => { for (const c of arr) if (q.length < size && !q.includes(c)) q.push(c); };
    if (opts.weakOnly) { push(shuffle(pool.filter(isWeak))); return q; }
    if (opts.newOnly) { push(fresh); return q; }
    if (opts.dueOnly) { push(due); return q; }
    push(due);
    const newCap = Math.max(0, Math.min(opts.newPerSession ?? 8, size - q.length));
    push(weak.slice(0, Math.ceil((size - q.length) / 2)));
    push(fresh.slice(0, newCap));
    push(weak); push(fresh); push(rest);
    return q.slice(0, size);
  }

  /* ---------- Answer matching ---------- */
  const STOP = new Set(['a','an','the','of','to','or','and','in','on','for','with','that','is','are','be','by','as','at','it','its','one','who','which','especially','something','someone','often','very','being','not','from','into']);

  function norm(s) {
    return s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  const sim = (a, b) => { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; };
  const stem = w => w.replace(/(ing|ed|es|s|ly)$/, '');

  // Typing a TERM (definition shown): strict-ish with small typo tolerance.
  function checkTerm(input, term) {
    const a = norm(input), b = norm(term);
    if (!a) return { ok: false, kind: 'empty' };
    if (a === b) return { ok: true, kind: 'exact' };
    const d = lev(a, b);
    const tol = b.length <= 4 ? 0 : b.length <= 8 ? 1 : 2;
    if (d <= tol) return { ok: true, kind: 'typo' };
    return { ok: false, kind: 'wrong' };
  }

  // Typing a DEFINITION (term shown): forgiving. Accept if it closely matches any clause,
  // or covers most of the meaningful words of any clause.
  function checkDef(input, def) {
    const a = norm(input);
    if (!a) return { ok: false, kind: 'empty' };
    const clauses = def.split(/[;]|,\s+(?=(?:or|and)\b)/).map(s => s.trim()).filter(Boolean);
    const all = [def, ...clauses];
    const aw = a.split(' ').filter(w => w && !STOP.has(w)).map(stem);
    let best = 0;
    for (const cl of all) {
      const b = norm(cl);
      if (!b) continue;
      if (a === b) return { ok: true, kind: 'exact', score: 1 };
      best = Math.max(best, sim(a, b));
      const bw = b.split(' ').filter(w => w && !STOP.has(w)).map(stem);
      if (!bw.length || !aw.length) continue;
      let hit = 0;
      for (const w of bw) if (aw.some(x => x === w || (w.length > 4 && sim(x, w) >= 0.8))) hit++;
      const cover = hit / bw.length;
      const precision = aw.filter(x => bw.some(w => x === w || (w.length > 4 && sim(x, w) >= 0.8))).length / aw.length;
      best = Math.max(best, Math.min(cover, 0.5 + precision / 2) * 0.95);
    }
    return { ok: best >= 0.72, kind: best >= 0.72 ? 'close' : 'wrong', score: best };
  }

  // A shorter one-line version of a definition (for tiles, cloze options, etc.)
  function shortDef(def, max = 70) {
    let s = def.split(/;/)[0].trim();
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
    return s;
  }
  // Blank the term inside a sentence (handles inflections like "eschatological")
  function blankOut(sentence, term) {
    const root = term.length > 5 ? term.slice(0, Math.max(4, term.length - 2)) : term;
    const re = new RegExp('\\b' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'ig');
    return sentence.replace(re, '_____');
  }

  function dayKey(t = Date.now()) {
    const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  return { parseVocab, mergeImport, newCard, review, stateOf, isDue, isWeak, weakScore, accuracy,
    buildQueue, shuffle, checkTerm, checkDef, shortDef, blankOut, norm, lev, dayKey, DAY, MIN, keyOf };
})();
if (typeof module !== 'undefined') module.exports = Logic;
