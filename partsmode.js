/* Roots & parts: lessons, flashcards, quiz and browser for the curated parts library (parts.js).
   Uses helpers from app.js (h, shell, renderMC, renderTyped, summary, ...) at call time only. */

const TYPE_LABEL = { prefix: 'Prefix', root: 'Root', suffix: 'Suffix' };
const PFIELDS = ['ease', 'interval', 'reps', 'lapses', 'due', 'seen', 'correct', 'streak', 'last', 'hist', 'modes'];
const PSTOP = new Set(['a', 'an', 'the', 'of', 'to', 'or', 'and', 'be', 'is', 'as', 'by']);
const ptok = s => String(s).toLowerCase().split(/[^a-z]+/).filter(w => w && !PSTOP.has(w)).map(w => w.replace(/(ing|ed|s)$/, ''));

/* ---------- state ---------- */
function initParts(prog) {
  S.partsProg = prog || {};
  S.parts = PART_LIBRARY.map(e => {
    const base = L.newCard({ set: e.type, term: e.part, def: e.meaning });
    const p = Object.assign(base, e, { id: 'part:' + e.key, kind: 'part', set: e.type, term: e.part, def: e.meaning });
    const sv = S.partsProg[e.key];
    if (sv) PFIELDS.forEach(f => { if (sv[f] !== undefined) p[f] = sv[f]; });
    return p;
  });
}
let partTimer = null;
function flushParts() { clearTimeout(partTimer); partTimer = null; Store.setKV('partsProgress', S.partsProg); }
function savePart(p) {
  S.partsProg[p.key] = Object.fromEntries(PFIELDS.map(f => [f, p[f]]));
  clearTimeout(partTimer); partTimer = setTimeout(flushParts, 250);
}
function recordPart(p, g, mode) {
  L.review(p, g, mode); savePart(p);
  const k = L.dayKey(); S.meta.log[k] = (S.meta.log[k] || 0) + 1; Store.setKV('meta', S.meta);
}
addEventListener('pagehide', () => { if (partTimer) flushParts(); });

/* ---------- helpers ---------- */
let deckIdx = null, deckLen = -1;
function deckCard(term) {
  if (!deckIdx || deckLen !== S.cards.length) { deckIdx = new Map(S.cards.map(c => [c.term.toLowerCase(), c])); deckLen = S.cards.length; }
  return deckIdx.get(String(term).toLowerCase());
}
const partWords = p => p.words.map(deckCard).filter(Boolean);
const partTokens = p => ptok([p.meaning, ...(p.alt || [])].join(' '));
const partsOverlap = (a, b) => { const t = partTokens(b); return partTokens(a).some(x => t.includes(x)); };
const bareForm = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
const partState = p => L.stateOf(p);

function partTag(p) { return h('span', { class: 'ptag ' + p.type }, TYPE_LABEL[p.type]); }
function partLines(p, max = 3) {
  const nodes = partWords(p).slice(0, max).map(c => h('div', { class: 'pex' }, h('b', null, c.term), ' — ', L.shortDef(c.def, 70)));
  if (p.extra && p.extra.length) nodes.push(h('div', { class: 'pex muted' }, 'Also: ' + p.extra.join(', ')));
  return nodes;
}
// The full description of a part, used in lessons, flashcard backs and the browser.
function partDetail(p, max = 3) {
  return h('div', { class: 'pdetail' },
    h('div', { class: 'prow' }, h('span', { class: 'pbig' }, p.part), partTag(p)),
    h('div', { class: 'pmean' }, p.meaning, p.alt && p.alt.length ? h('span', { class: 'muted' }, '  ·  also: ' + p.alt.join(', ')) : null),
    p.origin ? h('div', { class: 'note' }, p.origin) : null,
    p.tip ? h('div', { class: 'note' }, '💡 ' + p.tip) : null,
    h('div', { class: 'pexs' }, partLines(p, max)));
}

// Which parts to study: types/level are applied by the caller; this orders and trims.
function partQueue(P, which, n) {
  const now = Date.now();
  const TR = { prefix: 0, suffix: 1, root: 2 };
  const fresh = L.shuffle(P.filter(p => p.seen === 0)).sort((a, b) => a.level - b.level || TR[a.type] - TR[b.type] || b.words.length - a.words.length);
  if (which === 'all') return L.shuffle(P).slice(0, n);
  if (which === 'new') return fresh.slice(0, n);
  if (which === 'learned') return L.shuffle(P.filter(p => p.seen > 0)).slice(0, n);
  const due = P.filter(p => L.isDue(p, now)).sort((a, b) => a.due - b.due);
  if (which === 'due') return due.slice(0, n);
  const weak = L.shuffle(P.filter(p => L.isWeak(p)));
  if (which === 'weak') return weak.slice(0, n);
  const q = []; const push = arr => { for (const p of arr) if (q.length < n && !q.includes(p)) q.push(p); };
  push(due); push(weak.slice(0, Math.ceil((n - q.length) / 2)));
  push(fresh.slice(0, Math.max(0, Math.min(S.settings.newPer, n - q.length))));
  push(weak); push(fresh); push(L.shuffle(P.filter(p => p.seen > 0)));
  return q;
}

/* ---------- answer options ---------- */
function partMeaningOpts(p, n = 3) {
  const cands = L.shuffle(S.parts.filter(q => q.key !== p.key)).sort((a, b) => (b.type === p.type) - (a.type === p.type));
  const used = new Set([p.meaning.toLowerCase()]), out = [];
  for (const q of cands) {
    if (used.has(q.meaning.toLowerCase()) || partsOverlap(p, q)) continue;
    used.add(q.meaning.toLowerCase()); out.push(q.meaning); if (out.length === n) break;
  }
  return out;
}
function partFormOpts(p, n = 3) {
  const cands = L.shuffle(S.parts.filter(q => q.key !== p.key)).sort((a, b) => (b.type === p.type) - (a.type === p.type));
  const used = new Set([p.part.toLowerCase()]), out = [];
  for (const q of cands) {
    if (used.has(q.part.toLowerCase()) || partsOverlap(p, q) || q.forms.some(f => p.forms.includes(f))) continue;
    used.add(q.part.toLowerCase()); out.push(q.part); if (out.length === n) break;
  }
  return out;
}
function partWordOpts(p, n = 3) {
  const own = new Set(p.words.map(w => w.toLowerCase())), long = p.forms.filter(f => f.length >= 3);
  const cands = L.shuffle(S.cards.filter(c => !own.has(c.term.toLowerCase()) && !long.some(f => c.term.toLowerCase().includes(f))));
  return cands.slice(0, n).map(c => c.term);
}

/* ---------- questions ---------- */
// Every question returns the options for renderMC or renderTyped. pass 1 = gentler, pass 2 = harder.
function makePartQ(p, pass, typedOn) {
  const words = partWords(p);
  const w = words.length ? L.shuffle(words)[0] : null;
  const kinds = pass === 1 ? [['p2m', 4], ['inword', 3], ['m2p', 1.5], ['word', 1.5]] : [['m2p', 3], ['word', 3], ['p2m', 2], ['inword', 2]];
  const ok = kinds.filter(([k]) => w || (k !== 'inword' && k !== 'word'));
  let r = Math.random() * ok.reduce((a, [, x]) => a + x, 0), kind = ok[0][0];
  for (const [k, x] of ok) { if ((r -= x) < 0) { kind = k; break; } }
  const typed = typedOn && Math.random() < (pass === 1 ? .2 : .5);
  const extra = () => h('div', { class: 'vextra note' }, [p.origin, w ? 'e.g. ' + w.term : null].filter(Boolean).join(' · '));
  if (typed && kind !== 'word' && kind !== 'inword') {
    if (kind === 'm2p') {
      const same = S.parts.filter(q => q.type === p.type && (q.key === p.key || (q.meaning.toLowerCase() === p.meaning.toLowerCase())));
      const accept = new Set(same.flatMap(q => q.forms.map(bareForm)));
      return { typed: true, label: 'Type the ' + p.type, placeholder: 'Type it', prompt: h('div', { class: 'def' }, 'Which ' + p.type + ' means ', h('b', null, '“' + p.meaning + '”'), '?'),
        correctText: p.part + (p.forms.length > 1 ? '  (also ' + p.forms.filter(f => f !== bareForm(p.part)).join(', ') + ')' : ''),
        check: v => accept.has(bareForm(v)) ? { ok: true, kind: 'exact', grade: 2 } : { ok: false }, extra };
    }
    const want = new Set(partTokens(p));
    return { typed: true, label: 'Type the meaning', placeholder: 'What does it mean?', prompt: h('div', null, h('div', { class: 'big' }, p.part), partTag(p)),
      correctText: p.meaning + (p.alt && p.alt.length ? '  (also: ' + p.alt.join(', ') + ')' : ''),
      check: v => { const t = ptok(v); const hit = t.some(x => want.has(x)); return hit ? { ok: true, kind: 'exact', grade: t.length && [...want].every(x => t.includes(x)) ? 2 : 1 } : { ok: false }; }, extra };
  }
  if (kind === 'p2m') return { label: 'Pick the meaning', prompt: h('div', null, h('div', { class: 'big' }, p.part), partTag(p)), options: [p.meaning, ...partMeaningOpts(p)], answer: p.meaning };
  if (kind === 'm2p') return { label: 'Pick the ' + p.type, prompt: h('div', { class: 'def' }, 'Which ' + p.type + ' means ', h('b', null, '“' + p.meaning + '”'), '?'), options: [p.part, ...partFormOpts(p)], answer: p.part };
  if (kind === 'word') return { label: 'Pick the word', prompt: h('div', { class: 'def' }, 'Which word contains the ' + p.type + ' ', h('b', null, p.part), ' (“' + p.meaning + '”)?'), options: [w.term, ...partWordOpts(p)], answer: w.term };
  return { label: 'In “' + w.term + '”', prompt: h('div', { class: 'def' }, 'What does the ' + p.type + ' ', h('b', null, p.part), ' mean?'), options: [p.meaning, ...partMeaningOpts(p)], answer: p.meaning };
}

/* ---------- Learn parts ---------- */
function runPartLearn(queue, cfg) {
  const typedOn = !cfg || cfg.typed !== false;
  const total = queue.length, steps = total * 2, groups = chunkBal(queue, 5, 3);
  let gi = 0, done = 0; const missed = new Map(), recorded = new Set();
  const sh = shell('Learn parts', steps);
  const tag = () => groups.length > 1 ? `Round ${gi}/${groups.length} · ` : '';
  function round() {
    sh.progress(done, steps);
    if (gi >= groups.length) return summary({ correct: total - missed.size, total, missed: [...missed.values()], again: () => start('pLearn') });
    const g = groups[gi++];
    sh.body.replaceChildren(
      h('h2', null, groups.length > 1 ? `Round ${gi} of ${groups.length}: meet these parts` : 'Meet these parts'),
      h('p', { class: 'muted' }, 'Read them, then you will be asked about each one.'),
      btn('Start', 'primary block', () => ask(g)),
      ...g.map(p => h('div', { class: 'card' }, partDetail(p))));
    keyHandler = e => { if (e.key === 'Enter') ask(g); };
  }
  function ask(g) {
    const q = [...L.shuffle(g).map(p => ({ p, pass: 1 })), ...L.shuffle(g).map(p => ({ p, pass: 2 }))];
    next(q);
  }
  function grade(it, ok, g) {
    const p = it.p;
    if (!ok) { missed.set(p.id, p); if (!recorded.has(p.id)) { recorded.add(p.id); recordPart(p, 0, 'plearn'); } }
    else if (it.pass === 2 && !it.retry && !recorded.has(p.id)) { recorded.add(p.id); recordPart(p, g, 'plearn'); }
  }
  function next(q) {
    if (!q.length) return round();
    const it = q[0], p = it.p, spec = makePartQ(p, it.pass, typedOn);
    window.__lastPartQ = { key: p.key, typed: !!spec.typed, answer: spec.typed ? p.part : spec.answer, forms: p.forms, meaning: p.meaning };
    const fin = (ok, g) => {
      grade(it, ok, g); q.shift();
      if (!ok) { it.retry = true; q.splice(Math.min(3, q.length), 0, it); } else { done++; sh.progress(done, steps); }
      next(q);
    };
    if (spec.typed) renderTyped(sh.body, { label: tag() + spec.label, prompt: spec.prompt, placeholder: spec.placeholder, correctText: spec.correctText, check: spec.check, extra: spec.extra, onDone: (gr, ok) => fin(ok, gr) });
    else renderMC(sh.body, { label: tag() + spec.label, prompt: spec.prompt, options: spec.options, answer: spec.answer, reveal: ok => ok ? null : partDetail(p, 2), onDone: ok => fin(ok, 1) });
  }
  round();
}

/* ---------- Part flashcards ---------- */
function runPartFlash(queue) {
  const sh = shell('Part flashcards', queue.length);
  const q = queue.slice(), total = queue.length; let done = 0, correct = 0; const missed = new Map();
  function next() {
    sh.progress(done, total);
    if (!q.length) return summary({ correct, total, missed: [...missed.values()], again: () => start('pFlash') });
    const p = q[0], dir = pickDir(); let flipped = false;
    const card = h('div', { class: 'qcard flip', onclick: flip }), grades = h('div', { class: 'grades' });
    const front = dir === 't2d'
      ? h('div', null, h('div', { class: 'big' }, p.part), partTag(p))
      : h('div', { class: 'def' }, h('b', null, p.meaning), h('div', { class: 'muted' }, 'Which ' + p.type + '?'));
    function draw() {
      if (!flipped) card.replaceChildren(...kids(h('div', { class: 'lab' }, dir === 't2d' ? 'Part' : 'Meaning'), front, h('div', { class: 'hint' }, 'Tap to reveal')));
      else card.replaceChildren(...kids(h('div', { class: 'lab' }, dir === 't2d' ? 'Part' : 'Meaning'), front, h('hr'), partDetail(p)));
    }
    function flip() {
      if (flipped) return; flipped = true; draw();
      const now = Date.now();
      const pv = g => { const cp = JSON.parse(JSON.stringify(p)); L.review(cp, g, 'x', now); return fmtDur(cp.due - now); };
      grades.replaceChildren(...['Again', 'Hard', 'Good', 'Easy'].map((n, g) => h('button', { class: 'g' + g, onclick: () => grade(g) }, n, h('small', null, pv(g)))));
      keyHandler = e => { if (e.key >= '1' && e.key <= '4') grade(+e.key - 1); };
    }
    function grade(g) {
      recordPart(p, g, 'pflash'); q.shift();
      if (g === 0) { missed.set(p.id, p); q.splice(Math.min(3, q.length), 0, p); }
      else { done++; if (!missed.has(p.id)) correct++; }
      next();
    }
    draw(); sh.body.replaceChildren(card, grades);
    keyHandler = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
  }
  next();
}

/* ---------- Word quiz (parts inside your own words) ---------- */
function runPartQuiz(queue) {
  const items = queue.filter(p => partWords(p).length);
  if (!items.length) { toast('No parts to quiz yet. Try Learn first.'); return go('home'); }
  const sh = shell('Parts in words', items.length); let i = 0, correct = 0; const missed = [];
  function next() {
    sh.progress(i, items.length);
    if (i >= items.length) return summary({ correct, total: items.length, missed, again: () => start('pQuiz') });
    const p = items[i], w = L.shuffle(partWords(p))[0];
    const spec = Math.random() < .6
      ? { label: 'In “' + w.term + '”', prompt: h('div', { class: 'def' }, 'What does the ' + p.type + ' ', h('b', null, p.part), ' mean?'), options: [p.meaning, ...partMeaningOpts(p)], answer: p.meaning }
      : { label: 'Pick the word', prompt: h('div', { class: 'def' }, 'Which word contains the ' + p.type + ' ', h('b', null, p.part), ' (“' + p.meaning + '”)?'), options: [w.term, ...partWordOpts(p)], answer: w.term };
    window.__lastPartQ = { key: p.key, typed: false, answer: spec.answer };
    renderMC(sh.body, {
      label: spec.label, prompt: spec.prompt, options: spec.options, answer: spec.answer,
      reveal: () => h('div', { class: 'card' }, h('b', null, w.term), h('div', { class: 'muted' }, L.shortDef(w.def, 90)),
        h('div', { class: 'pexs' }, partsOfWord(w.term).map(q => h('div', { class: 'pex' }, h('b', null, q.part), ' = ' + q.meaning))), partDetail(p, 1)),
      onDone: ok => { recordPart(p, ok ? 2 : 0, 'pquiz'); note(w, ok, 'roots'); if (ok) correct++; else missed.push(p); i++; next(); }
    });
  }
  next();
}
function partsOfWord(term) { const t = term.toLowerCase(); return S.parts.filter(p => p.words.some(x => x.toLowerCase() === t)); }

/* ---------- hub and browser ---------- */
function openRootsHub() {
  tabsEl.hidden = true;
  const N = S.parts.length, started = S.parts.filter(p => p.seen > 0).length;
  const st = ['new', 'learning', 'reviewing', 'mastered'].map(s => [s, S.parts.filter(p => partState(p) === s).length]);
  const opt = (ico, name, desc, fn) => h('button', { class: 'mode wide', type: 'button', onclick: fn }, h('span', { class: 'ico' }, ico), h('b', null, name), h('small', null, desc));
  mount(h('div', { class: 'page' },
    h('div', { class: 'row', style: { marginBottom: '6px' } }, h('button', { class: 'icon', 'aria-label': 'Back', onclick: () => go('home') }, '←'), h('h1', { style: { margin: 0 } }, '🌿 Roots & parts')),
    h('p', { class: 'muted' }, 'Learn the building blocks of words, then see them inside your own vocabulary.'),
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', null, `${started} of ${N} parts started`), h('span', { class: 'muted' }, st.find(x => x[0] === 'mastered')[1] + ' mastered')),
      h('div', { class: 'bar', style: { marginTop: '8px' } }, h('div', { class: 'bar-fill', style: { width: Math.round(started / N * 100) + '%' } })),
      h('div', { class: 'legend' }, st.map(([s, n]) => h('span', null, h('i', { class: 'c-' + s }), `${s} ${n}`)))),
    h('div', { class: 'stack' },
      opt('🌱', 'Learn the parts', 'Meet a few at a time, then practise them', () => openSetup('pLearn')),
      opt('🃏', 'Part flashcards', 'Flip through parts and self-grade', () => openSetup('pFlash')),
      opt('🎯', 'Parts in your words', 'Quiz: what does the part in this word mean?', () => openSetup('pQuiz'))),
    btn('Browse all parts', 'block', openPartsBrowse, { style: { marginTop: '14px' } })));
}

function openPartsBrowse() {
  tabsEl.hidden = true;
  let q = '', f = 'all';
  const list = h('div');
  const chips = h('div', { class: 'chips wrap' });
  function draw() {
    const t = q.trim().toLowerCase();
    const rows = S.parts.filter(p => (f === 'all' || p.type === f) && (!t || p.part.toLowerCase().includes(t) || p.meaning.toLowerCase().includes(t) || p.words.some(w => w.toLowerCase().includes(t))));
    chips.replaceChildren(...[['all', 'All'], ['prefix', 'Prefixes'], ['root', 'Roots'], ['suffix', 'Suffixes']].map(([v, l]) => h('button', { class: 'chip' + (f === v ? ' on' : ''), type: 'button', onclick: () => { f = v; draw(); } }, l)));
    list.replaceChildren(...kids(rows.length ? rows.map(p => h('button', { class: 'item', type: 'button', onclick: () => { let close; close = sheet(h('div', null, partDetail(p, 6),
        h('p', { class: 'muted' }, p.seen ? `Seen ${p.seen}× · accuracy ${pct(L.accuracy(p))} · ${partState(p)}` : 'Not studied yet'), btn('Close', 'primary block', () => close()))); } },
      h('div', { class: 'grow' }, h('b', null, p.part), h('div', { class: 'muted' }, p.meaning)), h('span', { class: 'badge ' + partState(p) }, partState(p)))) : h('p', { class: 'muted' }, 'No parts match.')));
  }
  mount(h('div', { class: 'page' },
    h('div', { class: 'row', style: { marginBottom: '6px' } }, h('button', { class: 'icon', 'aria-label': 'Back', onclick: openRootsHub }, '←'), h('h1', { style: { margin: 0 } }, 'All parts')),
    h('input', { class: 'search', placeholder: 'Search a part, meaning or word', oninput: e => { q = e.target.value; draw(); } }), chips, list));
  draw();
}
