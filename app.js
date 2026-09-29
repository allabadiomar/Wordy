'use strict';
/* Wordy: UI, storage, study modes, AI helpers. Pure logic lives in logic.js. */
const L = Logic;
const $ = (s, r = document) => r.querySelector(s);
const appEl = $('#app'), tabsEl = $('#tabs'), toastEl = $('#toast');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- tiny DOM helper ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// Native replaceChildren/append turn null into the text "null", so nullable children go through kids().
const kids = (...a) => a.flat(Infinity).filter(k => k != null && k !== false);
const btn = (label, cls, onclick, extra) => h('button', { class: 'btn ' + (cls || ''), onclick, type: 'button', ...extra }, label);

/* ---------- state ---------- */
const DEFAULTS = { newPer: 8, last: {}, apiKey: '', model: 'gemini-3.8-flash' };
const S = { cards: [], settings: { ...DEFAULTS }, meta: { log: {} } };

/* ---------- storage (IndexedDB, localStorage fallback) ---------- */
const Store = (() => {
  let db = null; const pending = new Map(); let timer = null;
  const LS = k => 'wordy.' + k;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function init() {
    try {
      db = await new Promise((res, rej) => {
        const r = indexedDB.open('wordy', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('cards', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch { db = null; }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  }
  async function loadCards() {
    if (db) return req(db.transaction('cards').objectStore('cards').getAll());
    try { return JSON.parse(localStorage.getItem(LS('cards')) || '[]'); } catch { return []; }
  }
  async function getKV(k, d) {
    if (db) { const v = await req(db.transaction('kv').objectStore('kv').get(k)); return v === undefined ? d : v; }
    try { const v = localStorage.getItem(LS('kv.' + k)); return v == null ? d : JSON.parse(v); } catch { return d; }
  }
  function setKV(k, v) {
    if (db) db.transaction('kv', 'readwrite').objectStore('kv').put(JSON.parse(JSON.stringify(v)), k);
    else try { localStorage.setItem(LS('kv.' + k), JSON.stringify(v)); } catch {}
  }
  function flush() {
    if (!pending.size) return;
    const list = [...pending.values()]; pending.clear();
    if (db) { const s = db.transaction('cards', 'readwrite').objectStore('cards'); list.forEach(c => s.put(c)); }
    else try { localStorage.setItem(LS('cards'), JSON.stringify(S.cards)); } catch {}
  }
  function saveCard(c) { pending.set(c.id, c); clearTimeout(timer); timer = setTimeout(flush, 250); }
  async function replaceAll(cards) {
    pending.clear();
    if (db) {
      await new Promise((res, rej) => {
        const t = db.transaction('cards', 'readwrite'); const s = t.objectStore('cards');
        s.clear(); cards.forEach(c => s.put(c)); t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    } else try { localStorage.setItem(LS('cards'), JSON.stringify(cards)); } catch {}
  }
  addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  addEventListener('pagehide', flush);
  return { init, loadCards, getKV, setKV, saveCard, replaceAll, flush, get persistent() { return !!db; } };
})();

/* ---------- navigation ---------- */
let keyHandler = null; const leaveFns = [];
const onLeave = fn => leaveFns.push(fn);
const later = fn => setTimeout(fn, 0);
document.addEventListener('keydown', e => { if (keyHandler && !e.repeat && !e.metaKey && !e.ctrlKey) keyHandler(e); });
function mount(node) {
  document.documentElement.classList.remove('locked');
  keyHandler = null; while (leaveFns.length) { try { leaveFns.pop()(); } catch {} }
  appEl.replaceChildren(node); window.scrollTo(0, 0);
}
// iOS keeps the layout viewport full-height when the keyboard opens and pans the page instead.
// Track the visible area so session screens can size themselves to it and never get panned.
function syncViewport() {
  const vv = window.visualViewport; if (!vv) return;
  const r = document.documentElement.style;
  r.setProperty('--vvh', vv.height + 'px'); r.setProperty('--vvtop', vv.offsetTop + 'px');
}
if (window.visualViewport) { visualViewport.addEventListener('resize', syncViewport); visualViewport.addEventListener('scroll', syncViewport); syncViewport(); }
// Start of every question: forget the previous question's key shortcuts and scroll back to the top.
function beginQuestion() { keyHandler = null; appEl.scrollTop = 0; window.scrollTo(0, 0); }
const screens = { home: homeScreen, library: libraryScreen, stats: statsScreen, settings: settingsScreen };
let currentTab = 'home';
function go(name) {
  currentTab = name; tabsEl.hidden = false;
  tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.go === name));
  mount(screens[name]());
}
tabsEl.addEventListener('click', e => { const b = e.target.closest('button[data-go]'); if (b) go(b.dataset.go); });
let toastT;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 2600); }
const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

function sheet(content) {
  const ov = h('div', { class: 'overlay', onclick: e => { if (e.target === ov) close(); } }, h('div', { class: 'sheet' }, content));
  const close = () => ov.remove();
  document.body.append(ov);
  return close;
}

/* ---------- helpers ---------- */
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const fmtDur = ms => { const m = Math.max(1, Math.round(ms / 60000)); if (m < 60) return m + 'm'; const hh = Math.round(m / 60); if (hh < 24) return hh + 'h'; const d = Math.round(hh / 24); return d < 30 ? d + 'd' : Math.round(d / 30) + 'mo'; };
const pct = n => n == null ? '–' : Math.round(n * 100) + '%';
const SESSION = { dir: 'mixed' };   // direction chosen on the setup screen for the current session
const pickDir = () => SESSION.dir === 'mixed' ? (Math.random() < .5 ? 't2d' : 'd2t') : SESSION.dir;
// Split into groups of n, folding a tiny leftover group into the previous one.
function chunkBal(a, n, min) { const g = chunk(a, n); if (g.length > 1 && g[g.length - 1].length < min) { const last = g.pop(); g[g.length - 1].push(...last); } return g; }
// which: all (shuffled) | smart (due & weak first) | due | weak | new
function sessionQueue(P, which, n) {
  if (which === 'all') return L.shuffle(P).slice(0, n);
  const o = { newPerSession: S.settings.newPer };
  if (which !== 'smart') o[which + 'Only'] = true;
  return L.buildQueue(P, n, o);
}
function streak() {
  let n = 0, t = Date.now(); const log = S.meta.log;
  if (!log[L.dayKey(t)]) t -= L.DAY;
  while (log[L.dayKey(t)]) { n++; t -= L.DAY; }
  return n;
}
function distractors(card, n, pick = c => c.term, same) {
  const seen = new Set([pick(card).toLowerCase()]); const out = [];
  const src = L.shuffle(S.cards.filter(c => c.id !== card.id));
  if (same) src.sort((a, b) => (same(b, card) ? 1 : 0) - (same(a, card) ? 1 : 0));
  for (const c of src) { const t = pick(c); if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); if (out.length >= n) break; } }
  return out;
}
function touch(c) {
  Store.saveCard(c); const k = L.dayKey(); S.meta.log[k] = (S.meta.log[k] || 0) + 1; Store.setKV('meta', S.meta);
}
function record(c, g, mode) { L.review(c, g, mode); touch(c); }
function note(c, ok, mode) { const m = c.modes[mode] || (c.modes[mode] = { n: 0, ok: 0 }); m.n++; if (ok) m.ok++; touch(c); }
const partsView = ai => ai && ai.parts && ai.parts.length
  ? h('div', { class: 'parts' }, ai.parts.map(p => h('span', { class: 'part' }, p.part, h('i', null, p.meaning))))
  : null;


/* ---------- Pronunciation (free dictionary API audio, device voice as fallback) ---------- */
const Pron = {
  inflight: new Map(),
  // Cached on the card: {ipa, audio}. A 404 is cached too (empty), network errors are not.
  lookup(c) {
    if (c.pron) return Promise.resolve(c.pron);
    if (this.inflight.has(c.id)) return this.inflight.get(c.id);
    const p = (async () => {
      const out = { ipa: '', audio: '' };
      try {
        const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(c.term.toLowerCase()));
        if (r.ok) {
          for (const e of await r.json()) {
            const ph = e.phonetics || [];
            out.ipa = out.ipa || e.phonetic || (ph.find(x => x.text) || {}).text || '';
            const a = ph.find(x => x.audio); if (a && !out.audio) out.audio = a.audio.replace(/^http:/, 'https:');
          }
        } else if (r.status !== 404) return out;
      } catch { return out; }
      c.pron = out; Store.saveCard(c); return out;
    })().finally(() => this.inflight.delete(c.id));
    this.inflight.set(c.id, p); return p;
  },
  voice: null,
  // Prefer the best installed US English voice (premium/enhanced/Siri/neural, then Google) over the default.
  pickVoice() {
    try {
      const novelty = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Fred|Good News|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)/i;
      const score = v => /premium|enhanced|siri|neural|natural/i.test(v.name) ? 3 : /google/i.test(v.name) ? 2 : v.localService ? 1 : 0;
      this.voice = speechSynthesis.getVoices().filter(v => /^en[-_]US/i.test(v.lang) && !novelty.test(v.name)).sort((a, b) => score(b) - score(a))[0] || null;
    } catch { this.voice = null; }
  },
  say(text) {
    try {
      const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 0.9; if (this.voice) u.voice = this.voice;
      speechSynthesis.cancel(); speechSynthesis.speak(u); return true;
    } catch { return false; }
  },
  // Must start playing inside the tap (iOS blocks audio started after an await), so use what is cached
  // right now and fetch in the background for next time.
  speak(c) {
    if (c.pron && c.pron.audio) {
      const a = new Audio(c.pron.audio);
      const p = a.play(); if (p && p.catch) p.catch(() => Pron.say(c.term));
    } else { Pron.say(c.term); this.lookup(c); }
  },
  prefetch(cards) {
    const todo = cards.filter(c => !c.pron); let i = 0;
    const worker = async () => { while (i < todo.length) await this.lookup(todo[i++]); };
    worker(); worker(); worker();
  },
  // Slowly cache pronunciations for every word in the background so taps find a recording ready.
  crawling: false, gap: 600,
  async crawl() {
    if (this.crawling) return; this.crawling = true; let fails = 0;
    for (const c of S.cards) {
      if (c.pron) continue;
      if (!navigator.onLine || fails >= 3) break;   // offline or rate-limited: try again next launch
      await this.lookup(c);
      fails = c.pron ? 0 : fails + 1;
      await sleep(this.gap);
    }
    this.crawling = false;
  }
};
try { speechSynthesis.addEventListener('voiceschanged', () => Pron.pickVoice()); Pron.pickVoice(); } catch {}
// A term with a speaker button and (once known) its phonetic spelling.
function termLine(c, cls = 'big') {
  const ipa = h('div', { class: 'ipa' }, c.pron && c.pron.ipa || '');
  if (!c.pron) Pron.lookup(c).then(p => { ipa.textContent = p.ipa || ''; });
  return h('div', { class: 'termline' },
    h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px' } }, h('div', { class: cls }, c.term),
      h('button', { class: 'icon speak', type: 'button', 'aria-label': 'Hear ' + c.term, onclick: e => { e.stopPropagation(); Pron.speak(c); } }, '🔊')), ipa);
}

/* ---------- AI (Gemini via REST, key stored on this device only) ---------- */
const AI = {
  ready: () => !!S.settings.apiKey.trim(),
  async call(prompt, { temperature = 0.3, retries = 3 } = {}) {
    const { apiKey, model } = S.settings;
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: 'application/json' } };
    if (/2\.5/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    for (let a = 0; a <= retries; a++) {
      let res;
      try {
        res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() }, body: JSON.stringify(body) });
      } catch { if (a === retries) throw new Error('Network error. Are you online?'); await sleep(800 * (a + 1)); continue; }
      if (res.status === 429 || res.status >= 500) {
        if (a === retries) {
          const d = await res.json().catch(() => null); const m = (d && d.error && d.error.message) || '';
          throw new Error(`Google replied ${res.status} (${res.status === 429 ? 'rate limit or quota' : 'servers busy'}). ${m}`.slice(0, 320));
        }
        await sleep(2000 * (a + 1)); continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error && data.error.message) || 'AI error ' + res.status);
      const text = (((data.candidates || [])[0] || {}).content || {}).parts;
      const raw = (text || []).map(p => p.text || '').join('').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try { return JSON.parse(raw); } catch { if (a === retries) throw new Error('The AI returned something unreadable. Try again.'); }
    }
  },
  async enrich(cards) {
    const list = cards.map(c => `- ${c.term}: ${c.def}`).join('\n');
    const out = await AI.call(
`You are a precise English vocabulary and etymology tutor. For each word below (with its definition for context) return a JSON array with one object per word, in the same order:
{"term": exact word as given,
 "pos": "adj" | "noun" | "verb" | "adv",
 "parts": [{"part": "...", "type": "prefix" | "root" | "suffix", "meaning": "1-4 words"}],
 "origin": "one short line of etymology, e.g. From Latin ...",
 "mnemonic": "a short vivid memory hook, max 20 words",
 "sentence": "one natural sentence, 12-22 words, that contains the term exactly as written and lets a reader infer its meaning from context"}
Rules: parts appear in order of the word and use the real morphemes (e.g. "con-", "dict", "-ive"); show hyphens on prefixes and suffixes; if the word has no meaningful affix, give one root part. Never invent etymology you are unsure of; prefer a simpler true breakdown.

Words:
${list}`, { temperature: 0.4 });
    const arr = Array.isArray(out) ? out : (out && (out.words || out.items)) || [];
    let n = 0;
    cards.forEach((c, i) => {
      const r = arr.find(x => x && String(x.term).toLowerCase() === c.term.toLowerCase()) || arr[i];
      if (!r || typeof r !== 'object') return;
      const parts = (Array.isArray(r.parts) ? r.parts : []).filter(p => p && typeof p.part === 'string' && typeof p.meaning === 'string')
        .slice(0, 6).map(p => ({ part: p.part.trim(), type: ['prefix', 'root', 'suffix'].includes(p.type) ? p.type : 'root', meaning: p.meaning.trim() }));
      c.ai = { parts, origin: String(r.origin || ''), mnemonic: String(r.mnemonic || ''), sentence: String(r.sentence || ''), pos: String(r.pos || '') };
      Store.saveCard(c); n++;
    });
    return n;
  },
  judgeDef: (c, answer) => AI.call(
`A student is learning the word "${c.term}". Official definition: "${c.def}".
The student was asked for the meaning and wrote: "${answer}".
Decide whether the student's answer captures the core meaning (synonyms and paraphrases are fine; be fair, not pedantic).
Return JSON: {"ok": true|false, "feedback": "one short sentence"}`, { temperature: 0.1 }),
  judgeUse: (c, sentence) => AI.call(
`A student is practicing the word "${c.term}" (definition: "${c.def}"). They wrote this sentence: "${sentence}".
Judge whether the word is used correctly in meaning, form and grammar.
Return JSON: {"verdict": "correct" | "partial" | "incorrect", "feedback": "1-2 specific, encouraging sentences", "better": "a polished model sentence using the word"}`, { temperature: 0.3 })
};

// Make sure cards have AI data, with a cancellable loading screen. Resolves true when ready.
async function prepAI(cards, label) {
  if (!AI.ready()) { toast('Add your Gemini API key in Settings first'); go('settings'); return false; }
  const missing = cards.filter(c => !c.ai);
  if (!missing.length) return true;
  let cancelled = false;
  const msg = h('p', { class: 'muted center' }, 'Preparing ' + missing.length + ' words…');
  mount(h('div', { class: 'page center' }, h('h1', null, label), h('div', { class: 'spin' }), msg,
    btn('Cancel', 'small', () => { cancelled = true; go('home'); })));
  let done = 0;
  try {
    for (const grp of chunk(missing, 8)) {
      if (cancelled) return false;
      await AI.enrich(grp); done += grp.length;
      msg.textContent = `Analyzed ${done} of ${missing.length} words…`;
      if (done < missing.length) await sleep(500);
    }
  } catch (e) {
    if (cancelled) return false;
    mount(h('div', { class: 'page center' }, h('h1', null, 'AI hiccup'), h('p', null, e.message),
      h('div', { class: 'actions' }, btn('Back', '', () => go('home')))));
    return false;
  }
  return !cancelled;
}

/* ---------- shared session UI ---------- */
function shell(title, total) {
  const fill = h('div', { class: 'bar-fill' }), count = h('span', { class: 'count' });
  const body = h('div', { class: 'body' });
  let touched = false;
  const root = h('div', { class: 'session' },
    h('div', { class: 'sticky' },
      h('div', { class: 'top' },
        h('button', { class: 'icon', 'aria-label': 'End session', onclick: () => { if (!touched || confirm('End this session? Your answers so far are saved.')) go('home'); } }, '✕'),
        h('div', { class: 'title' }, title), count),
      h('div', { class: 'bar' }, fill)),
    body);
  tabsEl.hidden = true; mount(root); document.documentElement.classList.add('locked');
  return { body, progress(d, t, keep) {
    if (!keep) beginQuestion();
    touched = touched || d > 0; fill.style.width = (t ? Math.min(100, d / t * 100) : 0) + '%'; count.textContent = `${d}/${t}`;
  } };
}

function summary({ title = 'Session complete', correct, total, missed = [], extra, again }) {
  const p = total ? Math.round(correct / total * 100) : 0;
  tabsEl.hidden = true;
  mount(h('div', { class: 'page summary center' },
    h('h1', null, title),
    h('div', { class: 'ring', style: { '--p': p } }, h('div', null, p + '%')),
    h('p', null, `${correct} of ${total} right on the first try`),
    extra ? h('p', { class: 'muted' }, extra) : null,
    missed.length ? h('div', { class: 'card', style: { textAlign: 'left' } }, h('h3', null, 'Worth another look'),
      missed.map(c => h('div', { class: 'intro-item' }, h('b', null, c.term), h('div', { class: 'muted' }, c.def)))) : h('p', null, 'Clean sweep. 🎉'),
    h('div', { class: 'actions' }, again ? btn('Study again', 'primary', again) : null, btn('Home', '', () => go('home')))));
}

// Multiple choice with instant feedback. opts: {label, prompt, options:[string], answer:string, reveal?:()=>Node, onDone(ok)}
function renderMC(body, o) {
  beginQuestion();
  const shuffled = L.shuffle(o.options);
  const holder = h('div');
  const buttons = shuffled.map((t, i) => h('button', { class: 'opt', type: 'button', onclick: () => pick(i) }, h('b', { class: 'muted' }, (i + 1) + '  '), t));
  body.replaceChildren(h('div', { class: 'qcard' }, o.label ? h('div', { class: 'lab' }, o.label) : null, o.prompt), h('div', { class: 'opts' }, buttons), holder);
  let locked = false;
  function pick(i) {
    if (locked) return; locked = true;
    const ok = shuffled[i] === o.answer;
    buttons.forEach((b, j) => { b.disabled = true; if (shuffled[j] === o.answer) b.classList.add('right'); else if (j === i) b.classList.add('wrong'); });
    if (!ok) buzz(80);
    const rev = o.reveal && o.reveal(ok);
    if (ok && !rev) { setTimeout(() => o.onDone(true), 600); return; }
    const go1 = () => o.onDone(ok);
    holder.append(...kids(rev, h('div', { class: 'actions' }, btn('Continue', 'primary', go1))));
    later(() => { keyHandler = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go1(); } }; });
  }
  keyHandler = e => { const n = parseInt(e.key, 10); if (n >= 1 && n <= buttons.length) pick(n - 1); };
}

// Typed answer. First Enter (or Check) marks it and shows the verdict; a second Enter (or Continue) moves on.
// opts: {label, prompt, placeholder, multiline, check(val)->{ok,grade,kind}, correctText, judge?, extra?, onDone(grade, ok)}
function renderTyped(body, o) {
  beginQuestion();
  const input = h(o.multiline ? 'textarea' : 'input', { class: 'answer', placeholder: o.placeholder || 'Type your answer', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: false, enterKeyHint: 'go' });
  const verdictSlot = h('div'), acts = h('div', { class: 'actions' }), holder = h('div');
  let state = null, at = 0, finished = false;
  const proceed = () => { if (finished || !state) return; finished = true; o.onDone(state.grade, state.ok); };
  acts.append(btn('Check', 'primary block', () => submit(false)), btn("I don't know", 'block', () => submit(true)));
  body.replaceChildren(h('div', { class: 'qcard compact' }, h('div', { class: 'lab' }, o.label), o.prompt), verdictSlot, input, acts, holder);
  input.focus({ preventScroll: true });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault(); e.stopPropagation();
    if (!state) submit(false); else if (Date.now() - at > 300) proceed();   // the delay ignores a double-fired Enter
  });
  // keep the field (and the phone keyboard) open after checking, but stop it being edited
  input.addEventListener('beforeinput', e => { if (state) e.preventDefault(); });
  input.addEventListener('input', () => { if (state && input.value !== state.value) input.value = state.value; });

  function submit(giveUp) {
    if (state) return;
    const v = input.value.trim();
    if (!v && !giveUp) { input.focus({ preventScroll: true }); return; }
    const r = giveUp ? { ok: false, grade: 0 } : o.check(v);
    state = { ok: r.ok, grade: r.ok ? r.grade : 0, kind: r.kind, value: input.value }; at = Date.now();
    input.classList.add('locked', r.ok ? 'good' : 'bad');
    if (!r.ok) buzz(80);
    const title = h('b', null, r.ok ? (r.kind === 'typo' ? 'Correct (mind the spelling)' : 'Correct') : (giveUp ? 'Answer' : 'Not quite'));
    const verdict = h('div', { class: 'result ' + (r.ok ? 'ok' : 'no') }, title, h('div', { class: 'ans' }, o.correctText), (!r.ok && v) ? h('div', { class: 'note' }, 'You wrote: ' + v) : null);
    verdictSlot.replaceChildren(verdict);
    const extras = []; let overrideBtn = null, aiBtn = null;
    const accept = label => { state = { ...state, ok: true, grade: 1 }; verdict.className = 'result ok'; title.textContent = label; overrideBtn && overrideBtn.remove(); aiBtn && aiBtn.remove(); };
    if (!r.ok && v) {
      overrideBtn = btn('I was right', 'good small', () => accept('Counted as correct'));
      extras.push(overrideBtn);
      if (o.judge && AI.ready()) {
        aiBtn = btn('Ask AI ✨', 'small', async () => {
          aiBtn.disabled = true; aiBtn.textContent = 'Thinking…';
          try {
            const j = await o.judge(v);
            verdict.append(h('div', { class: 'note' }, '✨ ' + (j.feedback || '')));
            if (j.ok) accept('AI accepted it'); else aiBtn.remove();
          } catch (e) { aiBtn.disabled = false; aiBtn.textContent = 'Ask AI ✨'; toast(e.message); }
        });
        extras.push(aiBtn);
      }
    }
    acts.replaceChildren(...kids(btn('Continue', 'primary block', proceed), extras.length ? h('div', { class: 'actions', style: { marginTop: '8px' } }, extras) : null));
    holder.append(...kids(o.extra ? o.extra() : null));
    // fallback if focus has moved off the field (desktop): Enter still continues
    keyHandler = e => { if (e.key === 'Enter' && document.activeElement !== input && Date.now() - at > 300) { e.preventDefault(); proceed(); } };
  }
}

/* ---------- study modes ---------- */
function runFlash(queue) {
  const sh = shell('Flashcards', queue.length);
  const q = queue.slice(); const total = queue.length; let done = 0, correct = 0; const missed = new Map();
  function next() {
    sh.progress(done, total);
    if (!q.length) return summary({ correct, total, missed: [...missed.values()], again: () => start('flash') });
    const c = q[0], dir = pickDir(); let flipped = false;
    const frontLab = dir === 't2d' ? 'Term' : 'Definition';
    const card = h('div', { class: 'qcard flip', onclick: flip });
    const grades = h('div', { class: 'grades' });
    function draw() {
      const front = dir === 't2d' ? termLine(c) : h('div', { class: 'def' }, c.def);
      if (!flipped) card.replaceChildren(h('div', { class: 'lab' }, frontLab), front, h('div', { class: 'hint' }, 'Tap to reveal'));
      else {
        const back = dir === 't2d' ? h('div', { class: 'def' }, c.def) : termLine(c);
        card.replaceChildren(...kids(h('div', { class: 'lab' }, frontLab), front, h('hr'), back, partsView(c.ai), c.ai && c.ai.mnemonic ? h('div', { class: 'note' }, '💡 ' + c.ai.mnemonic) : null));
      }
    }
    function flip() {
      if (flipped) return; flipped = true; draw();
      const now = Date.now();
      const pv = g => { const cp = JSON.parse(JSON.stringify(c)); L.review(cp, g, 'x', now); return fmtDur(cp.due - now); };
      grades.replaceChildren(...['Again', 'Hard', 'Good', 'Easy'].map((n, g) => h('button', { class: 'g' + g, onclick: () => grade(g) }, n, h('small', null, pv(g)))));
      keyHandler = e => { if (e.key >= '1' && e.key <= '4') grade(+e.key - 1); };
    }
    function grade(g) {
      record(c, g, 'flash'); q.shift();
      if (g === 0) { missed.set(c.id, c); q.splice(Math.min(3, q.length), 0, c); }
      else { done++; if (!missed.has(c.id)) correct++; }
      next();
    }
    draw();
    sh.body.replaceChildren(card, grades);
    keyHandler = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
  }
  next();
}

function runWrite(queue) {
  const sh = shell('Write', queue.length);
  const q = queue.slice(); const total = queue.length; let done = 0, correct = 0; const missed = new Map();
  function next() {
    sh.progress(done, total);
    if (!q.length) return summary({ correct, total, missed: [...missed.values()], again: () => start('write') });
    const c = q[0], dir = pickDir(), t2d = dir === 't2d';
    renderTyped(sh.body, {
      label: t2d ? 'Type the definition' : 'Type the term',
      prompt: h('div', { class: t2d ? 'big' : 'def' }, t2d ? c.term : c.def),
      placeholder: t2d ? 'What does it mean?' : 'Which word is this?',
      multiline: t2d,
      correctText: t2d ? c.def : c.term,
      check: v => {
        const r = t2d ? L.checkDef(v, c.def) : L.checkTerm(v, c.term);
        return { ok: r.ok, kind: r.kind, grade: r.kind === 'exact' ? 2 : r.kind === 'typo' ? 1 : (r.score >= 0.9 ? 2 : 1) };
      },
      judge: t2d ? v => AI.judgeDef(c, v) : null,
      extra: () => h('div', { class: 'card center' }, termLine(c, 'def'), partsView(c.ai), c.ai && c.ai.origin ? h('div', { class: 'note center' }, c.ai.origin) : null),
      onDone: (g, ok) => {
        record(c, g, 'write'); q.shift();
        if (!ok) { missed.set(c.id, c); q.splice(Math.min(3, q.length), 0, c); }
        else { done++; if (!missed.has(c.id)) correct++; }
        next();
      }
    });
  }
  next();
}

function runLearn(queue) {
  const total = queue.length; const groups = chunkBal(queue, 5, 3); let gi = 0, done = 0, correct = 0; const missed = new Map();
  const sh = shell('Learn', total);
  function round() {
    sh.progress(done, total);
    if (gi >= groups.length) return summary({ correct, total, missed: [...missed.values()], again: () => start('learn') });
    const g = groups[gi++];
    sh.body.replaceChildren(
      h('h2', null, g.some(c => c.seen === 0) ? 'Meet these words' : 'Quick look'),
      h('div', { class: 'card' }, g.map(c => h('div', { class: 'intro-item' }, h('div', { class: 'row' }, h('b', null, c.term), h('button', { class: 'icon speak', type: 'button', 'aria-label': 'Hear ' + c.term, onclick: () => Pron.speak(c) }, '🔊')), h('div', null, c.def), partsView(c.ai)))),
      btn('Start', 'primary block', () => mcPhase(g)));
    keyHandler = e => { if (e.key === 'Enter') mcPhase(g); };
  }
  function mcPhase(g) {
    const q = L.shuffle(g);
    (function nextQ() {
      if (!q.length) return typePhase(g);
      const c = q[0], t2d = Math.random() < .5;
      renderMC(sh.body, {
        label: t2d ? 'Pick the meaning' : 'Pick the word',
        prompt: h('div', { class: t2d ? 'big' : 'def' }, t2d ? c.term : c.def),
        options: t2d ? [L.shortDef(c.def, 110), ...distractors(c, 3, x => L.shortDef(x.def, 110))] : [c.term, ...distractors(c, 3)],
        answer: t2d ? L.shortDef(c.def, 110) : c.term,
        onDone: ok => { q.shift(); if (!ok) q.push(c); nextQ(); }
      });
    })();
  }
  function typePhase(g) {
    const q = L.shuffle(g); const tried = new Set();
    (function nextQ() {
      if (!q.length) return round();
      const c = q[0];
      renderTyped(sh.body, {
        label: 'Type the term', prompt: h('div', { class: 'def' }, c.def), placeholder: 'Which word is this?',
        correctText: c.term,
        check: v => { const r = L.checkTerm(v, c.term); return { ok: r.ok, kind: r.kind, grade: r.kind === 'exact' ? 2 : 1 }; },
        onDone: (gr, ok) => {
          if (!tried.has(c.id)) { tried.add(c.id); record(c, ok ? gr : 0, 'learn'); if (!ok) missed.set(c.id, c); else correct++; }
          q.shift();
          if (!ok) q.push(c); else { done++; sh.progress(done, total); }
          nextQ();
        }
      });
    })();
  }
  round();
}

function makeTestQ(c) {
  const r = Math.random();
  if (r < .3) return { c, type: 'mc', prompt: c.def, label: 'Which word matches?', options: [c.term, ...distractors(c, 3)], answer: c.term, show: c.term };
  if (r < .6) return { c, type: 'mc', prompt: c.term, label: 'What does it mean?', options: [L.shortDef(c.def, 110), ...distractors(c, 3, x => L.shortDef(x.def, 110))], answer: L.shortDef(c.def, 110), show: L.shortDef(c.def, 110), big: true };
  if (r < .8) {
    const truth = Math.random() < .5; let d = L.shortDef(c.def, 110);
    if (!truth) { const o = distractors(c, 1, x => L.shortDef(x.def, 110))[0]; if (o) d = o; }
    return { c, type: 'tf', prompt: `${c.term}: ${d}`, label: 'True or false?', answer: d === L.shortDef(c.def, 110) ? 'True' : 'False', show: d === L.shortDef(c.def, 110) ? 'True' : 'False (' + L.shortDef(c.def, 110) + ')' };
  }
  return { c, type: 'write', prompt: c.def, label: 'Type the term', answer: c.term, show: c.term };
}
function runTest(queue) {
  const qs = queue.map(makeTestQ); const res = [];
  const sh = shell('Test', qs.length); let i = 0;
  function next() {
    sh.progress(i, qs.length);
    if (i >= qs.length) return finish();
    const q = qs[i];
    const record1 = (given, ok) => { res.push({ q, given, ok }); i++; next(); };
    if (q.type === 'mc') {
      const opts = L.shuffle(q.options);
      sh.body.replaceChildren(h('div', { class: 'qcard' }, h('div', { class: 'lab' }, q.label), h('div', { class: q.big ? 'big' : 'def' }, q.prompt)),
        h('div', { class: 'opts' }, opts.map((t, k) => h('button', { class: 'opt', onclick: () => record1(t, t === q.answer) }, h('b', { class: 'muted' }, (k + 1) + '  '), t))));
      keyHandler = e => { const n = parseInt(e.key, 10); if (n >= 1 && n <= opts.length) record1(opts[n - 1], opts[n - 1] === q.answer); };
    } else if (q.type === 'tf') {
      sh.body.replaceChildren(h('div', { class: 'qcard' }, h('div', { class: 'lab' }, q.label), h('div', { class: 'def' }, q.prompt)),
        h('div', { class: 'opts' }, ['True', 'False'].map(t => h('button', { class: 'opt', onclick: () => record1(t, t === q.answer) }, t))));
      keyHandler = e => { if (e.key === '1' || e.key.toLowerCase() === 't') record1('True', q.answer === 'True'); if (e.key === '2' || e.key.toLowerCase() === 'f') record1('False', q.answer === 'False'); };
    } else {
      const input = h('input', { class: 'answer', placeholder: 'Type the term', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: false });
      const sub = () => record1(input.value.trim() || '(blank)', L.checkTerm(input.value, q.c.term).ok);
      sh.body.replaceChildren(h('div', { class: 'qcard' }, h('div', { class: 'lab' }, q.label), h('div', { class: 'def' }, q.prompt)), input, h('div', { class: 'actions' }, btn('Submit', 'primary', sub)));
      input.focus(); input.addEventListener('keydown', e => { if (e.key === 'Enter') sub(); });
    }
  }
  function finish() {
    res.forEach(r => record(r.q.c, r.ok ? 2 : 0, 'test'));
    const correct = res.filter(r => r.ok).length; const wrong = res.filter(r => !r.ok);
    tabsEl.hidden = true;
    mount(h('div', { class: 'page center' }, h('h1', null, 'Test results'),
      h('div', { class: 'ring', style: { '--p': Math.round(correct / res.length * 100) } }, h('div', null, `${correct}/${res.length}`)),
      wrong.length ? h('div', { class: 'card', style: { textAlign: 'left' } }, h('h3', null, 'Missed'), wrong.map(r => h('div', { class: 'intro-item' }, h('b', null, r.q.c.term), h('div', { class: 'muted' }, 'You: ' + r.given), h('div', null, 'Answer: ' + r.q.show)))) : h('p', null, 'Perfect score. 🎉'),
      h('div', { class: 'actions' }, btn('New test', 'primary', () => start('test')), btn('Home', '', () => go('home')))));
  }
  next();
}

function runMatch(queue) {
  const cards = queue, groups = chunkBal(cards, 6, 3); let gi = 0, matchedAll = 0, totalTime = 0, clean = 0; const missed = new Map();
  const sh = shell('Match', cards.length);
  function round() {
    sh.progress(matchedAll, cards.length);
    if (gi >= groups.length) return summary({ correct: clean, total: cards.length, missed: [...missed.values()], extra: 'Total time ' + totalTime.toFixed(1) + 's', again: () => start('match') });
    const g = groups[gi++]; const mistakes = new Map(g.map(c => [c.id, 0])); let sel = null, matched = 0; const t0 = Date.now();
    const timer = h('div', { class: 'timer' }, '0.0s');
    const iv = setInterval(() => { timer.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's'; }, 100); onLeave(() => clearInterval(iv));
    const mk = (kind, c) => { const el = h('button', { class: 'tile', type: 'button', onclick: () => pick(kind, c, el) }, kind === 'term' ? c.term : L.shortDef(c.def, 80)); return el; };
    function pick(kind, c, el) {
      if (el.classList.contains('done')) return;
      if (!sel || sel.kind === kind) { if (sel) sel.el.classList.remove('sel'); sel = { kind, c, el }; el.classList.add('sel'); return; }
      if (sel.c.id === c.id) {
        sel.el.classList.add('done'); el.classList.add('done'); sel = null; matched++; matchedAll++; sh.progress(matchedAll, cards.length, true);
        if (matched === g.length) {
          clearInterval(iv); const t = (Date.now() - t0) / 1000; totalTime += t;
          g.forEach(x => { const m = mistakes.get(x.id); record(x, m === 0 ? 2 : m === 1 ? 1 : 0, 'match'); if (m === 0) clean++; else missed.set(x.id, x); });
          toast('Round done in ' + t.toFixed(1) + 's'); setTimeout(round, 700);
        }
      } else {
        mistakes.set(sel.c.id, mistakes.get(sel.c.id) + 1); mistakes.set(c.id, mistakes.get(c.id) + 1);
        const a = sel.el; sel = null; a.classList.remove('sel'); a.classList.add('shake'); el.classList.add('shake'); buzz(60);
        setTimeout(() => { a.classList.remove('shake'); el.classList.remove('shake'); }, 320);
      }
    }
    sh.body.replaceChildren(timer, h('div', { class: 'mgrid' }, h('div', null, L.shuffle(g).map(c => mk('term', c))), h('div', null, L.shuffle(g).map(c => mk('def', c)))));
  }
  round();
}

async function runRoots(queue) {
  if (!(await prepAI(queue, 'Roots & parts'))) return;
  const items = queue.filter(c => c.ai && c.ai.parts.length);
  if (!items.length) { toast('No word breakdowns available yet'); return go('home'); }
  const bank = S.cards.flatMap(c => (c.ai ? c.ai.parts : []));
  const FALL = ['not', 'before', 'under', 'across', 'again', 'to carry', 'to write', 'above', 'one who', 'full of', 'to see', 'against'];
  const sh = shell('Roots & parts', items.length); let i = 0, correct = 0; const missed = [];
  function next() {
    sh.progress(i, items.length);
    if (i >= items.length) return summary({ correct, total: items.length, missed, again: () => start('roots') });
    const c = items[i], p = c.ai.parts[Math.floor(Math.random() * c.ai.parts.length)];
    const seen = new Set([p.meaning.toLowerCase()]); const pool2 = L.shuffle(bank.filter(x => x.type === p.type)).concat(L.shuffle(bank), L.shuffle(FALL.map(m => ({ meaning: m }))));
    const wrong = []; for (const x of pool2) { const m = x.meaning.toLowerCase(); if (!seen.has(m)) { seen.add(m); wrong.push(x.meaning); if (wrong.length === 3) break; } }
    renderMC(sh.body, {
      label: `In “${c.term}”`, prompt: h('div', { class: 'def' }, 'What does the ', h('b', null, p.type), ' ', h('b', null, p.part), ' mean?'),
      options: [p.meaning, ...wrong], answer: p.meaning,
      reveal: ok => h('div', { class: 'card center' }, h('b', null, c.term), partsView(c.ai), c.ai.origin ? h('div', { class: 'note' }, c.ai.origin) : null, c.ai.mnemonic ? h('div', { class: 'note' }, '💡 ' + c.ai.mnemonic) : null, h('div', { class: 'note' }, c.def)),
      onDone: ok => { note(c, ok, 'roots'); if (ok) correct++; else missed.push(c); i++; next(); }
    });
  }
  next();
}

async function runContext(queue) {
  if (!(await prepAI(queue, 'Context'))) return;
  const items = queue.filter(c => c.ai && c.ai.sentence && L.blankOut(c.ai.sentence, c.term) !== c.ai.sentence);
  if (!items.length) { toast('No usable example sentences yet'); return go('home'); }
  const sh = shell('In context', items.length); let i = 0, correct = 0; const missed = [];
  function next() {
    sh.progress(i, items.length);
    if (i >= items.length) return summary({ correct, total: items.length, missed, again: () => start('context') });
    const c = items[i];
    renderMC(sh.body, {
      label: 'Fill in the blank', prompt: h('div', { class: 'def' }, L.blankOut(c.ai.sentence, c.term)),
      options: [c.term, ...distractors(c, 3, x => x.term, (a, b) => a.ai && b.ai && a.ai.pos === b.ai.pos)], answer: c.term,
      reveal: () => h('div', { class: 'card' }, h('div', null, c.ai.sentence), h('div', { class: 'note' }, c.term + ': ' + c.def)),
      onDone: ok => { record(c, ok ? 2 : 0, 'context'); if (ok) correct++; else missed.push(c); i++; next(); }
    });
  }
  next();
}

function runUseIt(queue) {
  if (!AI.ready()) { toast('Add your Gemini API key in Settings first'); return go('settings'); }
  const items = queue; const sh = shell('Use it', items.length); let i = 0, correct = 0; const missed = [];
  function next() {
    sh.progress(i, items.length);
    if (i >= items.length) return summary({ correct, total: items.length, missed, again: () => start('useit') });
    const c = items[i];
    const input = h('textarea', { class: 'answer', placeholder: `Write a sentence using “${c.term}”`, autocapitalize: 'sentences' });
    const out = h('div'); const submit = btn('Check with AI ✨', 'primary block', async () => {
      const v = input.value.trim(); if (v.length < 8) { toast('Write a full sentence'); return; }
      submit.disabled = true; submit.textContent = 'Thinking…';
      try {
        const j = await AI.judgeUse(c, v); const g = j.verdict === 'correct' ? 2 : j.verdict === 'partial' ? 1 : 0;
        input.disabled = true; submit.remove(); record(c, g, 'useit'); if (g >= 1) correct++; else missed.push(c);
        out.append(h('div', { class: 'result ' + (g ? 'ok' : 'no') }, h('b', null, j.verdict === 'correct' ? 'Nice' : j.verdict === 'partial' ? 'Almost' : 'Not quite'), h('div', { class: 'ans' }, j.feedback), j.better ? h('div', { class: 'note' }, 'Model: ' + j.better) : null),
          h('div', { class: 'actions' }, btn('Continue', 'primary', () => { i++; next(); })));
      } catch (e) { submit.disabled = false; submit.textContent = 'Check with AI ✨'; toast(e.message); }
    });
    sh.body.replaceChildren(h('div', { class: 'qcard' }, h('div', { class: 'lab' }, 'Use it in a sentence'), h('div', { class: 'big' }, c.term), h('div', { class: 'note' }, c.def)), input, h('div', { class: 'actions' }, submit, btn('Skip', '', () => { i++; next(); })), out);
    input.focus();
  }
  next();
}

const MODES = {
  flash: { name: 'Flashcards', ico: '🃏', desc: 'Flip and self-grade', run: runFlash },
  learn: { name: 'Learn', ico: '🌱', desc: 'Meet words in small batches', run: runLearn },
  write: { name: 'Write', ico: '✍️', desc: 'Type the term or meaning', run: runWrite },
  test: { name: 'Test', ico: '📝', desc: 'Mixed quiz with a score', run: runTest },
  match: { name: 'Match', ico: '⚡', desc: 'Race to pair them up', run: runMatch },
  roots: { name: 'Roots & parts', ico: '🌿', desc: 'Prefixes, roots, suffixes', run: runRoots, ai: true },
  context: { name: 'In context', ico: '💬', desc: 'Fill the blank in a sentence', run: runContext, ai: true },
  useit: { name: 'Use it', ico: '🎯', desc: 'Write a sentence, get feedback', run: runUseIt, ai: true }
};
// Build a fresh queue from a saved config and launch the mode. Returns false if nothing matches.
function startWith(key, cfg) {
  const sets = new Set(cfg.sets), P = S.cards.filter(c => sets.has(c.set));
  const q = sessionQueue(P, cfg.which, cfg.count === 'all' ? P.length : cfg.count);
  if (!q.length) { toast('No words match those choices.'); return false; }
  SESSION.dir = cfg.dir || 'mixed';
  window.__wordy && (window.__wordy.lastQueue = q);
  Pron.prefetch(q); MODES[key].run(q); return true;
}
// "Study again" etc.: repeat with the same choices, or ask if there are none yet.
function start(key) { const cfg = (S.settings.last || {})[key]; if (cfg && startWith(key, cfg)) return; openSetup(key); }

// Pre-session screen: choose sets, which words, how many, and direction.
function openSetup(key) {
  const m = MODES[key], allSets = [...new Set(S.cards.map(c => c.set))].sort().reverse();
  const saved = (S.settings.last || {})[key] || {};
  const chosen = new Set((saved.sets || []).filter(x => allSets.includes(x)));
  if (!chosen.size) allSets.forEach(x => chosen.add(x));
  const st = { which: saved.which || 'all', count: saved.count || (m.ai ? 20 : 'all'), dir: saved.dir || 'mixed' };
  const dirApplies = key === 'flash' || key === 'write';
  const body = h('div'); let startBtn = null, avail = 0;
  const effective = () => st.count === 'all' ? avail : Math.min(st.count, avail);
  const startLabel = () => `Start · ${effective()} ${effective() === 1 ? 'word' : 'words'}`;
  function begin() {
    const cfg = { sets: [...chosen], which: st.which, count: st.count, dir: st.dir };
    S.settings.last = { ...(S.settings.last || {}), [key]: cfg }; saveSettings(); startWith(key, cfg);
  }
  function pickSet(x) {
    if (chosen.size === allSets.length) { chosen.clear(); chosen.add(x); }   // from "all": isolate this set
    else if (chosen.has(x)) chosen.delete(x); else chosen.add(x);
    draw();
  }
  const WHICH = { all: 'Everything', smart: 'Smart mix', due: 'Due for review', weak: 'Weak words', new: 'Not studied yet' };
  let setsText = '', sumEl = null;
  const summaryText = () => `${setsText}  →  ${WHICH[st.which]}  →  ${effective()} of ${avail} ${avail === 1 ? 'word' : 'words'}`;
  function draw() {
    const allOn = chosen.size === allSets.length;
    setsText = allOn ? 'all sets' : chosen.size ? [...chosen].sort().reverse().join(' + ') : 'no sets';
    const now = Date.now(), P = S.cards.filter(c => chosen.has(c.set));
    const n = { all: P.length, smart: P.length, due: P.filter(c => L.isDue(c, now)).length, weak: P.filter(L.isWeak).length, new: P.filter(c => c.seen === 0).length };
    avail = n[st.which];
    const presets = [10, 25, 50, 100].filter(v => v < avail);
    const covers = st.count === 'all' || st.count >= avail;
    const custom = typeof st.count === 'number' && st.count < avail && !presets.includes(st.count);
    startBtn = btn(startLabel(), 'primary block', begin, { disabled: effective() === 0 });
    body.replaceChildren(...kids(
      h('h2', null, '1. Sets'),
      h('div', { class: 'chips wrap' }, [
        h('button', { class: 'chip' + (allOn ? ' on' : ''), type: 'button', onclick: () => { allSets.forEach(x => chosen.add(x)); draw(); } }, `All sets · ${S.cards.length}`),
        ...allSets.map(x => h('button', { class: 'chip' + (chosen.has(x) && !allOn ? ' on' : ''), type: 'button', onclick: () => pickSet(x) }, `${x} · ${S.cards.filter(c => c.set === x).length}`))]),
      h('p', { class: 'note' }, 'Tap a set to study just that one. Tap more to combine them.'),
      h('h2', null, '2. Which words'),
      h('p', { class: 'note' }, `Counts below are only for: ${setsText}.`),
      h('div', { class: 'opts tight' }, [['all', 'Everything, shuffled'], ['smart', 'Smart mix (due & weak first)'], ['due', 'Due for review'], ['weak', 'Weak words'], ['new', 'Not studied yet']].map(([v, l]) =>
        h('button', { class: 'opt' + (st.which === v ? ' sel' : ''), type: 'button', onclick: () => { st.which = v; draw(); } }, l, h('small', { class: 'muted' }, '  ·  ' + n[v])))),
      h('h2', null, `3. How many (of ${avail})`),
      h('div', { class: 'chips wrap' }, [['all', `All (${avail})`], ...presets.map(v => [v, String(v)])].map(([v, l]) => h('button', { class: 'chip' + ((v === 'all' ? covers : st.count === v) ? ' on' : ''), type: 'button', onclick: () => { st.count = v; draw(); } }, l))),
      h('input', { class: 'search', type: 'number', inputMode: 'numeric', min: 1, placeholder: 'Or type a number', value: custom ? st.count : '',
        oninput: e => { const v = parseInt(e.target.value, 10); st.count = v > 0 ? v : 'all'; startBtn.textContent = startLabel(); startBtn.disabled = effective() === 0; sumEl.textContent = summaryText(); },
        onchange: () => draw() }),
      dirApplies ? [h('h2', null, '4. Direction'), h('div', { class: 'chips wrap' }, [['mixed', 'Mixed'], ['t2d', 'Term → definition'], ['d2t', 'Definition → term']].map(([v, l]) => h('button', { class: 'chip' + (st.dir === v ? ' on' : ''), type: 'button', onclick: () => { st.dir = v; draw(); } }, l)))] : null,
      m.ai ? h('p', { class: 'note' }, 'AI modes prepare each word with Gemini first, so smaller sessions start faster.') : null,
      avail === 0 ? h('p', { class: 'note' }, chosen.size ? 'No words match. Try another option above.' : 'Pick at least one set.') : null,
      (sumEl = h('div', { class: 'card note center', style: { marginTop: '16px' } }, summaryText())),
      startBtn));
  }
  draw(); tabsEl.hidden = true;
  mount(h('div', { class: 'page' }, h('div', { class: 'row', style: { marginBottom: '6px' } }, h('button', { class: 'icon', 'aria-label': 'Back', onclick: () => go('home') }, '←'), h('h1', { style: { margin: 0 } }, m.ico + ' ' + m.name)), h('p', { class: 'muted' }, m.desc), body));
}

/* ---------- detail sheet ---------- */
function openDetail(c, after) {
  const box = h('div');
  let close;
  function draw() {
    const st = L.stateOf(c);
    box.replaceChildren(
      h('div', { class: 'row between' }, termLine(c, 'h1'), h('span', { class: 'badge ' + st }, st)),
      h('p', null, c.def), h('p', { class: 'muted' }, `Set ${c.set} · seen ${c.seen}× · accuracy ${pct(L.accuracy(c))} · streak ${c.streak}` + (c.seen ? ` · next review ${c.due <= Date.now() ? 'now' : 'in ' + fmtDur(c.due - Date.now())}` : '')),
      c.ai ? h('div', { class: 'card' }, partsView(c.ai), c.ai.origin ? h('div', { class: 'note center' }, c.ai.origin) : null, c.ai.mnemonic ? h('div', { class: 'note center' }, '💡 ' + c.ai.mnemonic) : null, c.ai.sentence ? h('div', { class: 'note center' }, '“' + c.ai.sentence + '”') : null)
        : (AI.ready() ? btn('Break down this word ✨', 'block', async e => { e.target.disabled = true; e.target.textContent = 'Thinking…'; try { await AI.enrich([c]); draw(); } catch (er) { toast(er.message); draw(); } }) : h('p', { class: 'note' }, 'Add a Gemini key in Settings to see roots, origin and a memory hook.')),
      h('div', { class: 'actions' },
        btn('Mark mastered', 'small', () => { c.seen = Math.max(c.seen, 1); c.reps = 5; c.interval = 30; c.due = Date.now() + 30 * L.DAY; Store.saveCard(c); toast('Marked mastered'); draw(); after && after(); }),
        btn('Reset progress', 'small', () => { if (confirm('Reset progress for “' + c.term + '”?')) { Object.assign(c, { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, seen: 0, correct: 0, streak: 0, last: 0, hist: [], modes: {} }); Store.saveCard(c); draw(); after && after(); } }),
        btn('Close', 'small primary', () => close())));
  }
  draw(); close = sheet(box);
}

/* ---------- screens ---------- */
function homeScreen() {
  const P = S.cards, now = Date.now();
  const cnt = { due: P.filter(c => L.isDue(c, now)).length, weak: P.filter(L.isWeak).length, fresh: P.filter(c => c.seen === 0).length, mastered: P.filter(c => L.stateOf(c) === 'mastered').length };
  const s = streak();
  return h('div', { class: 'page' },
    h('div', { class: 'head' }, h('h1', null, 'Wordy'), s ? h('span', { class: 'streak' }, '🔥 ' + s + (s === 1 ? ' day' : ' days')) : null),
    h('div', { class: 'tiles' },
      [['Due', cnt.due], ['New', cnt.fresh], ['Weak', cnt.weak], ['Mastered', cnt.mastered]].map(([l, n]) => h('div', { class: 'tile-stat' }, h('b', null, n), h('small', null, l)))),
    h('h2', null, 'Study'),
    h('div', { class: 'modes' },
      Object.entries(MODES).map(([k, m], i) => h('button', { class: 'mode' + (i === 0 ? ' hero' : ''), onclick: () => openSetup(k) },
        m.ai ? h('span', { class: 'badge ai' }, 'AI') : null, h('span', { class: 'ico' }, m.ico), h('b', null, m.name), h('small', null, m.desc)))));
}

function libraryScreen() {
  let q = '', f = 'all', setF = 'all';
  const list = h('div');
  const setChips = h('div', { class: 'chips' });
  const filters = ['all', 'new', 'learning', 'reviewing', 'mastered', 'weak'];
  const chips = h('div', { class: 'chips' });
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search terms or meanings', oninput: e => { q = e.target.value.toLowerCase(); draw(); } });
  const libSets = [...new Set(S.cards.map(c => c.set))].sort().reverse();
  function draw() {
    setChips.replaceChildren(...['all', ...libSets].map(x => h('button', { class: 'chip' + (setF === x ? ' on' : ''), onclick: () => { setF = x; draw(); } }, x === 'all' ? 'All sets' : x)));
    chips.replaceChildren(...filters.map(x => h('button', { class: 'chip' + (f === x ? ' on' : ''), onclick: () => { f = x; draw(); } }, x[0].toUpperCase() + x.slice(1))));
    const rows = S.cards.filter(c => (setF === 'all' || c.set === setF) && (!q || c.term.toLowerCase().includes(q) || c.def.toLowerCase().includes(q)) && (f === 'all' || (f === 'weak' ? L.isWeak(c) : L.stateOf(c) === f))).sort((a, b) => a.term.localeCompare(b.term));
    list.replaceChildren(h('p', { class: 'muted' }, rows.length + (rows.length === 1 ? ' term' : ' terms')), ...rows.slice(0, 300).map(c => h('button', { class: 'item', onclick: () => openDetail(c, draw) },
      h('div', { class: 'grow' }, h('b', null, c.term), h('small', { class: 'muted' }, L.shortDef(c.def, 90))), h('span', { class: 'badge ' + L.stateOf(c) }, L.stateOf(c)))));
    if (rows.length > 300) list.append(h('p', { class: 'muted center' }, 'Refine your search to see more'));
  }
  draw();
  return h('div', { class: 'page' }, h('h1', null, 'Library'), search, setChips, chips, list);
}

function statsScreen() {
  const all = S.cards, seen = all.filter(c => c.seen > 0);
  const tot = seen.reduce((a, c) => a + c.seen, 0), ok = seen.reduce((a, c) => a + c.correct, 0);
  const sets = [...new Set(all.map(c => c.set))].sort().reverse();
  const days = Array.from({ length: 14 }, (_, i) => { const t = Date.now() - (13 - i) * L.DAY; return { k: L.dayKey(t), n: S.meta.log[L.dayKey(t)] || 0, d: new Date(t).toLocaleDateString(undefined, { weekday: 'narrow' }) }; });
  const max = Math.max(1, ...days.map(d => d.n));
  const hard = all.filter(c => L.weakScore(c) > 0).sort((a, b) => L.weakScore(b) - L.weakScore(a)).slice(0, 10);
  const modeAgg = {}; all.forEach(c => Object.entries(c.modes).forEach(([m, v]) => { const a = modeAgg[m] || (modeAgg[m] = { n: 0, ok: 0 }); a.n += v.n; a.ok += v.ok; }));
  const stateCount = list => ['new', 'learning', 'reviewing', 'mastered'].map(s => [s, list.filter(c => L.stateOf(c) === s).length]);
  return h('div', { class: 'page' }, h('h1', null, 'Progress'),
    h('div', { class: 'tiles' }, [['Terms', all.length], ['Studied', seen.length], ['Mastered', all.filter(c => L.stateOf(c) === 'mastered').length], ['Accuracy', tot ? Math.round(ok / tot * 100) + '%' : '–']].map(([l, n]) => h('div', { class: 'tile-stat' }, h('b', null, n), h('small', null, l)))),
    h('div', { class: 'card' }, h('h3', null, 'Last 14 days'), h('div', { class: 'act' }, days.map(d => h('div', { class: d.n ? '' : 'zero', style: { height: Math.max(4, d.n / max * 100) + '%' }, title: d.n + ' answers' }))),
      h('div', { class: 'row between muted', style: { fontSize: '.75rem', marginTop: '4px' } }, days.map(d => h('span', null, d.d)))),
    h('div', { class: 'card' }, h('h3', null, 'Mastery by set'), sets.map(s => { const l = all.filter(c => c.set === s); return h('div', { style: { margin: '10px 0' } }, h('div', { class: 'row between' }, h('b', null, s), h('small', { class: 'muted' }, l.length + (l.length === 1 ? ' term' : ' terms'))), h('div', { class: 'seg' }, stateCount(l).map(([st, n]) => h('i', { class: 'c-' + st, style: { width: n / l.length * 100 + '%' } })))); }),
      h('div', { class: 'legend' }, ['new', 'learning', 'reviewing', 'mastered'].map(s => h('span', null, h('i', { class: 'c-' + s }), s)))),
    h('div', { class: 'card' }, h('h3', null, 'Hardest terms'), hard.length ? hard.map(c => h('button', { class: 'item', onclick: () => openDetail(c, () => go('stats')) }, h('div', { class: 'grow' }, h('b', null, c.term), h('small', { class: 'muted' }, L.shortDef(c.def, 80))), h('small', { class: 'muted' }, c.lapses + (c.lapses === 1 ? ' lapse' : ' lapses')))) : h('p', { class: 'muted' }, 'Nothing yet. Study a bit and your trouble words will show up here.')),
    Object.keys(modeAgg).length ? h('div', { class: 'card' }, h('h3', null, 'Accuracy by mode'), Object.entries(modeAgg).map(([m, v]) => h('div', { class: 'row between', style: { padding: '4px 0' } }, h('span', null, (MODES[m] ? MODES[m].name : m)), h('b', null, Math.round(v.ok / v.n * 100) + '%  '), h('small', { class: 'muted' }, v.n + ' answers')))) : null);
}

function saveSettings() { Store.setKV('settings', S.settings); }
function download(name, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove();
}
async function importText(text) {
  const parsed = L.parseVocab(text);
  if (!parsed.length) return toast('No term/definition pairs found');
  const r = L.mergeImport(S.cards, parsed); S.cards = r.cards; await Store.replaceAll(S.cards);
  toast(`Imported: ${r.added} new, ${r.updated} updated, ${r.same} unchanged`); go('settings');
}
function settingsScreen() {
  const set = (k, v) => { S.settings[k] = v; saveSettings(); };
  const sel = (label, key, opts, num) => h('label', { class: 'field' }, h('span', null, label), h('select', { onchange: e => set(key, num ? +e.target.value : e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(S.settings[key]) === String(v) }, l))));
  const aiCount = S.cards.filter(c => c.ai).length;
  const enrichBtn = btn(`Analyze all words with AI (${S.cards.length - aiCount} left)`, 'block', async () => {
    if (!AI.ready()) return toast('Add your API key first');
    const todo = S.cards.filter(c => !c.ai); if (!todo.length) return toast('All words are already analyzed');
    if (!confirm(`This makes about ${Math.ceil(todo.length / 8)} API calls. Continue?`)) return;
    enrichBtn.disabled = true; let n = 0;
    try { for (const g of chunk(todo, 8)) { await AI.enrich(g); n += g.length; enrichBtn.textContent = `Analyzed ${n}/${todo.length}…`; await sleep(1200); } toast('Done'); go('settings'); }
    catch (e) { toast(e.message); enrichBtn.disabled = false; }
  });
  const paste = h('textarea', { placeholder: '1. term - definition\n2. term - definition', style: { minHeight: '110px' } });
  const file = h('input', { type: 'file', accept: '.txt,.md,.csv,.tsv,text/plain', hidden: true, onchange: async e => { const f = e.target.files[0]; if (f) importText(await f.text()); } });
  const bfile = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!Array.isArray(d.cards)) throw 0; if (!confirm('Replace current progress with this backup?')) return; S.cards = d.cards; S.meta = d.meta || { log: {} }; await Store.replaceAll(S.cards); Store.setKV('meta', S.meta); toast('Backup restored'); go('home'); }
    catch { toast('That file is not a Wordy backup'); }
  } });
  return h('div', { class: 'page' }, h('h1', null, 'Settings'),
    h('div', { class: 'card' }, h('h3', null, 'Smart mix'),
      h('p', { class: 'note' }, 'Session size, sets and direction are chosen each time you start a mode.'),
      sel('New words mixed into a Smart session', 'newPer', [[0, '0'], [4, '4'], [8, '8'], [12, '12'], [20, '20']], true)),
    h('div', { class: 'card' }, h('h3', null, 'AI (Gemini) ✨'),
      h('p', { class: 'note' }, 'Powers Roots, In context, Use it, and “Ask AI”. Your key stays on this device and is sent only to Google. Get a free key at aistudio.google.com/apikey.'),
      h('label', { class: 'field' }, h('span', null, 'API key'), h('input', { type: 'password', value: S.settings.apiKey, placeholder: 'AIza…', autocomplete: 'off', onchange: e => set('apiKey', e.target.value.trim()) })),
      h('label', { class: 'field' }, h('span', null, 'Model'), h('input', { value: S.settings.model, autocapitalize: 'off', onchange: e => set('model', e.target.value.trim() || DEFAULTS.model) })),
      h('div', { class: 'actions' }, btn('Test connection', 'small', async e => { e.target.disabled = true; try { const r = await AI.call('Reply with JSON {"ok": true}', { retries: 1 }); toast(r && r.ok ? 'Connected ✓' : 'Unexpected reply'); } catch (er) { toast(er.message); } e.target.disabled = false; })),
      enrichBtn),
    h('div', { class: 'card' }, h('h3', null, 'Vocabulary'),
      h('p', { class: 'note' }, 'Re-importing matches on set + term: new words are added, changed definitions updated, and your progress is kept. Formats: “12. term - definition”, “term | definition”, or tab-separated, with “# Vocabulary Set: 2027” headers to name sets.'),
      h('div', { class: 'actions' }, btn('Import .txt file', 'primary', () => file.click())), file,
      h('label', { class: 'field' }, h('span', null, 'Or paste terms'), paste), btn('Import pasted text', 'small', () => importText(paste.value))),
    h('div', { class: 'card' }, h('h3', null, 'Pronunciation'),
      h('p', { class: 'note' }, `Recordings saved on this device: ${S.cards.filter(c => c.pron && c.pron.audio).length} of ${S.cards.length} words. Words without a recording use your phone's built-in voice. Wordy fetches the rest slowly in the background while you're online.`)),
    h('div', { class: 'card' }, h('h3', null, 'Backup'),
      h('p', { class: 'note' }, Store.persistent ? 'Progress is saved on this device. Export a backup now and then, especially before clearing browser data.' : 'Warning: this browser blocked IndexedDB, so progress is saved in a fallback that may be cleared.'),
      h('div', { class: 'actions' }, btn('Export backup', '', () => download('wordy-backup-' + L.dayKey() + '.json', JSON.stringify({ v: 1, cards: S.cards, meta: S.meta }))), btn('Restore backup', '', () => bfile.click())), bfile,
      btn('Reset all progress', 'bad block', async () => { if (!confirm('Erase all progress? Terms are kept.')) return; S.cards = S.cards.map(c => L.newCard(c)); S.meta = { log: {} }; await Store.replaceAll(S.cards); Store.setKV('meta', S.meta); toast('Progress reset'); go('home'); }, { style: { marginTop: '10px' } })),
    h('div', { class: 'card' }, h('h3', null, 'Install on your phone'),
      h('p', { class: 'note' }, 'iPhone: open in Safari → Share → Add to Home Screen. Android: Chrome menu → Install app. It then runs full-screen and works offline.')));
}

/* ---------- boot ---------- */
(async function boot() {
  await Store.init();
  S.settings = { ...DEFAULTS, ...(await Store.getKV('settings', {})) };
  S.meta = await Store.getKV('meta', { log: {} }); if (!S.meta.log) S.meta.log = {};
  S.cards = await Store.loadCards();
  if (!S.cards.length && typeof SEED_TEXT === 'string') {
    const r = L.mergeImport([], L.parseVocab(SEED_TEXT)); S.cards = r.cards; await Store.replaceAll(S.cards); setTimeout(() => toast(`Loaded ${r.added} terms`), 400);
  }
  go('home');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setTimeout(() => Pron.crawl(), 3000);
  window.__wordy = { S, L, Store, AI, Pron, start, startWith, openSetup, go };
})();
