// The server's side of Marquee's languages (the web app's is public/i18n.js). The code stays in English; messages
// on their way to a person are translated from src/i18n-sv.json, where {0}, {1}… stand for the parts that vary.
// A message that isn't listed stays English, so a missing line can't break anything.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

const LANGUAGES = new Set(['en', 'sv']);
const catalogues = { sv: JSON.parse(fs.readFileSync(new URL('./i18n-sv.json', import.meta.url), 'utf8')) };
const current = new AsyncLocalStorage();

// Lines with blanks in them, as patterns: 'Waking {0}' matches 'Waking magi'.
const patterns = {};
function patternsFor(lang) {
  if (patterns[lang]) return patterns[lang];
  patterns[lang] = Object.keys(catalogues[lang]).filter((k) => /\{\d+\}/.test(k)).map((key) => {
    const order = [];
    const source = key.split(/(\{\d+\})/).map((part) => {
      const blank = part.match(/^\{(\d+)\}$/);
      if (!blank) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      order.push(blank[1]);
      return '([\\s\\S]*?)';
    }).join('');
    return { regex: new RegExp(`^${source}$`), order, line: catalogues[lang][key] };
  });
  return patterns[lang];
}

export const validLanguage = (code) => LANGUAGES.has(code);

// The app and the TV say which language they're showing; pages reached by a link go by the cookie, then the browser.
export function languageOf(req) {
  const asked = String(req.headers['x-marquee-lang'] || '').toLowerCase();
  if (validLanguage(asked)) return asked;
  const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)marquee_lang=(\w+)/)?.[1];
  if (validLanguage(cookie)) return cookie;
  return /^sv\b/i.test(String(req.headers['accept-language'] || '')) ? 'sv' : 'en';
}

export const inLanguage = (lang, work) => current.run(lang, work);
export const currentLanguage = () => current.getStore() || 'en';

// One message into a language. Text that isn't in the catalogue comes back as it was.
export function translate(text, lang = currentLanguage()) {
  if (typeof text !== 'string' || !text || !catalogues[lang]) return text;
  const exact = catalogues[lang][text];
  if (exact) return exact;
  for (const { regex, order, line } of patternsFor(lang)) {
    const hit = text.match(regex);
    // The blanks stay as they are: they hold titles and names, which aren't ours to translate.
    if (hit) return order.reduce((out, n, i) => out.replace(`{${n}}`, () => hit[i + 1]), line);
  }
  return text;
}

// A line written in the code, with its blanks filled in: tr('Open {0}', name).
export function tr(text, ...args) {
  const line = catalogues[currentLanguage()]?.[text] ?? text;
  return line.replace(/\{(\d+)\}/g, (whole, i) => args[+i] ?? '');
}

// The fixed text of a page the server draws, for people who follow a share link.
export function translateHtml(html, lang = currentLanguage()) {
  if (!catalogues[lang]) return html;
  return html
    .replace(/<html lang="en">/, `<html lang="${lang}">`)
    .replace(/(>)([^<>]+)(<)/g, (whole, a, text, b) => {
      const key = text.trim();
      const line = key && catalogues[lang][key];
      return line ? a + text.replace(key, () => line) + b : whole;
    })
    .replace(/\b(aria-label|title|placeholder)="([^"]+)"/g, (whole, attr, text) => {
      const line = catalogues[lang][text];
      return line ? `${attr}="${line}"` : whole;
    });
}
