# Wordy

Installable vocabulary trainer (PWA): spaced repetition, 8 study modes, optional Gemini AI. Runs entirely in the browser; progress is stored on-device (IndexedDB).

## Put it on your phone
1. Host this folder over HTTPS (needed for install + offline). Easiest: drag the folder onto https://app.netlify.com/drop, or push it to GitHub and enable GitHub Pages, or deploy with Vercel.
2. Open the URL on your phone.
   - iPhone: Safari -> Share -> Add to Home Screen.
   - Android: Chrome menu -> Install app.

## Updating your words
Settings -> Import .txt file. Matches on set + term: new words added, changed definitions updated, progress kept.
Format: `# Vocabulary Set: 2027` headers, then `12. term - definition` (also `term | definition` or tab-separated).

## AI features (optional)
Settings -> paste a free Gemini key from https://aistudio.google.com/apikey. The key stays on your device.
Unlocks Roots & parts, In context, Use it, "Ask AI" on Write answers, and word breakdowns in the Library.
The model name is editable in Settings if you want a different one.

## Pronunciation
Every term has a speaker button (flashcards, Learn, Write results, word detail). It plays a recorded pronunciation from the free dictionary API when one exists, otherwise your phone's built-in voice. IPA spelling shows when available. Results are cached on the device.

## Back up
Settings -> Export backup (JSON) now and then. Clearing browser data erases on-device progress.

## Files
index.html, style.css, app.js (UI), logic.js (parsing/SRS/matching, unit-tested), vocab.js (your seed list, first run only), sw.js (offline), manifest + icons.
