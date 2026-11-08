// Marquee's languages. The code is written in English: T('Save') looks the line up in the chosen language's
// catalogue (public/i18n-sv.js) and fills in {0}, {1}…. A line that's missing stays English.
// tests/i18n.test.mjs fails when a line in the code has no Swedish, so nothing slips through.
export const LANGUAGES = [{ code: 'en', name: 'English' }, { code: 'sv', name: 'Svenska' }];
const STORE_KEY = 'marquee:lang';

function chooseLanguage() {
  const known = (code) => LANGUAGES.some((l) => l.code === code);
  try {
    const saved = globalThis.localStorage?.getItem(STORE_KEY);
    if (known(saved)) return saved;
  } catch { /* storage blocked: go by the cookie or the browser */ }
  const cookie = String(globalThis.document?.cookie || '').match(/(?:^|;\s*)marquee_lang=(\w+)/)?.[1];
  if (known(cookie)) return cookie;
  return /^sv\b/i.test(globalThis.navigator?.language || '') ? 'sv' : 'en';
}

export const lang = chooseLanguage();
export const langTag = lang === 'sv' ? 'sv-SE' : 'en-GB';
// For dates and numbers: Swedish when Swedish is on, otherwise whatever this device is set to, as before.
export const locale = lang === 'sv' ? 'sv-SE' : undefined;

let catalogue = {};
if (lang !== 'en') {
  try { catalogue = (await import(`./i18n-${lang}.js`)).default; } catch { /* no catalogue: stay in English */ }
}

export function T(text, ...args) {
  const line = catalogue[text] ?? text;
  if (!args.length) return line;
  return line.replace(/\{(\d+)\}/g, (whole, i) => args[+i] ?? '');
}

// Remembers a language on this device, and in a cookie for the pages the server draws (sign-in, shared clips).
export function saveLanguage(code) {
  try { globalThis.localStorage?.setItem(STORE_KEY, code); } catch { /* the cookie still works */ }
  if (globalThis.document) document.cookie = `marquee_lang=${code}; path=/; max-age=31536000; samesite=lax`;
}

// index.html is written in English too: swap its fixed text and labels once, before the app draws anything.
const STATIC_ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
export function translatePage(root = document.body) {
  document.documentElement.lang = lang;
  document.documentElement.classList.remove('i18n-wait');
  if (lang === 'en') return;
  const swap = (s) => { const k = s.trim(); return k && catalogue[k] ? s.replace(k, catalogue[k]) : s; };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = swap(n.nodeValue);
  for (const el of root.querySelectorAll('*')) {
    for (const a of STATIC_ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, swap(el.getAttribute(a)));
  }
}
