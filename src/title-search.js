import { showKey } from './shows.js';

const YEAR_SUFFIX = /^(.*?)\s*(?:\(((?:19|20)\d{2})\)|((?:19|20)\d{2}))\s*$/;

export function parseCatalogueSearch(raw) {
  const rawText = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const match = YEAR_SUFFIX.exec(rawText);
  const title = match?.[1]?.trim();
  // A title that is itself a year ("1917", "1984") stays a title.
  if (!title) return { raw: rawText, title: rawText, year: null };
  return { raw: rawText, title, year: Number(match[2] || match[3]) };
}

export function needsExactCatalogueFallback(search) {
  const parsed = typeof search === 'string' ? parseCatalogueSearch(search) : search;
  return Boolean(parsed?.year) || showKey(parsed?.title).length <= 2;
}

const typeOf = (x) => x.media_type || (x.first_air_date !== undefined ? 'tv' : 'movie');
const yearOf = (x) => Number(String(x.release_date || x.first_air_date || '').slice(0, 4)) || null;
const titleKeys = (x) => [x.title, x.original_title, x.name, x.original_name].filter(Boolean).map(showKey);

// Merge multi-search with type-specific fallbacks. Exact title/year matches go first, while the
// remaining TMDB relevance order stays intact. Specific endpoints do not include media_type, so add it.
export function mergeCatalogueResults(search, groups) {
  const parsed = typeof search === 'string' ? parseCatalogueSearch(search) : search;
  const expected = showKey(parsed?.title);
  const seen = new Set();
  const all = [];
  for (const group of groups || []) {
    for (const item of group || []) {
      const type = typeOf(item);
      if (!['movie', 'tv'].includes(type) || item?.id == null) continue;
      const key = `${type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(item.media_type ? item : { ...item, media_type: type });
    }
  }

  const exact = [], rest = [];
  for (const item of all) {
    const titleMatch = expected && titleKeys(item).includes(expected);
    const yearMatch = !parsed?.year || yearOf(item) === parsed.year;
    (titleMatch && yearMatch ? exact : rest).push(item);
  }
  return [...exact, ...rest];
}
