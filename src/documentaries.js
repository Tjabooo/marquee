// Documentaries in Discover: categories built from TMDB's genre + keyword + country filters, plus SVT
// Play's own documentary categories (src/svtplay.js). TMDB has one Documentary genre, so "true crime" or
// "nature" here means the genre together with the keywords people tag those titles with.
//
// A category's `queries` are alternatives: each is asked for, and the answers merged. Keyword IDs are
// TMDB's and don't change (look one up with /search/keyword). `query` gives film and show parameters,
// which only differ where TMDB's genre lists do: History, War and Music have no show genre.

const DOCUMENTARY = 99, CRIME = 80, HISTORY = 36, WAR = 10752, TV_WAR = 10768, MUSIC = 10402;
const NEWS = 10763, TALK = 10767, SOAP = 10766;
const anyOf = (...ids) => ids.join('|');

const KW = {
  trueCrime: 33722, serialKiller: 10714, coldCase: 210662, unsolved: 210661, disappearance: 10941, missingPerson: 156091,
  fraud: 4373, scandal: 3692, heist: 10051, cult: 6158, organizedCrime: 10291, prison: 378, forensic: 160313,
  history: 282633, worldWar2: 1956, coldWar: 2106, espionage: 5265, royal: 4833,
  nature: 18330, natureDoc: 221355, animalsNature: 284176, wildlife: 9902, animal: 361118, ocean: 270, climate: 2210, environment: 33577,
  disaster: 5096, science: 287067, medicine: 1279, psychology: 2800, health: 3721, technology: 1576, space: 9882, dinosaur: 12616,
  music: 283297, art: 14893, architecture: 12436, fashion: 15479, biography: 5565, sports: 6075, motorsport: 242128,
  food: 10637, travel: 9935, adventure: 322942, politics: 6078, humanRights: 18339, poverty: 12987, terrorism: 13015,
  religion: 11001, finance: 246911, economy: 3681,
};

const both = (params) => ({ movie: params, tv: params });
const keywords = (...ids) => both({ with_genres: String(DOCUMENTARY), with_keywords: anyOf(...ids) });
const SWEDEN = { with_origin_country: 'SE' };

// Order matters: this is the order on the page. `lively` lets obscure titles through (few Swedish
// documentaries have many votes on TMDB); everything else needs a few votes to keep out empty pages.
export const CATEGORIES = [
  // True crime
  { id: 'svt-true-crime', name: 'True crime on SVT Play', group: 'True crime', svt: 'true-crime' },
  { id: 'swedish-true-crime', name: 'Swedish true crime', group: 'True crime', lively: true, swedish: true, queries: [
    both({ with_genres: `${DOCUMENTARY},${CRIME}`, ...SWEDEN }),
    both({ with_keywords: String(KW.trueCrime), ...SWEDEN }), // Efterlyst and Veckans brott count as talk shows
  ] },
  { id: 'true-crime', name: 'True crime', group: 'True crime', queries: [
    both({ with_genres: `${DOCUMENTARY},${CRIME}` }),
    keywords(KW.trueCrime),
  ] },
  { id: 'serial-killers', name: 'Serial killers', group: 'True crime', queries: [keywords(KW.serialKiller)] },
  { id: 'cold-cases', name: 'Unsolved and missing', group: 'True crime', queries: [keywords(KW.coldCase, KW.unsolved, KW.disappearance, KW.missingPerson, KW.forensic)] },
  { id: 'scams', name: 'Scams and scandals', group: 'True crime', queries: [keywords(KW.fraud, KW.scandal, KW.heist)] },
  { id: 'cults', name: 'Cults', group: 'True crime', queries: [keywords(KW.cult)] },
  { id: 'gangs', name: 'Gangs and prisons', group: 'True crime', queries: [keywords(KW.organizedCrime, KW.prison)] },
  // Sweden and the Nordics
  { id: 'svt-series', name: 'Documentary series on SVT Play', group: 'Sweden and the Nordics', svt: 'dokumentarserier' },
  { id: 'svt-swedish-films', name: 'Swedish documentary films on SVT Play', group: 'Sweden and the Nordics', svt: 'svensk-dokumentarfilm' },
  { id: 'svt-inifran', name: 'Dokument inifrån', group: 'Sweden and the Nordics', svt: 'dokument-inifran' },
  { id: 'svt-archive', name: 'From the SVT archive', group: 'Sweden and the Nordics', svt: 'dokumentar-oppet-arkiv' },
  { id: 'swedish', name: 'Swedish documentaries', group: 'Sweden and the Nordics', lively: true, swedish: true, queries: [both({ with_genres: String(DOCUMENTARY), ...SWEDEN })] },
  { id: 'nordic', name: 'Nordic documentaries', group: 'Sweden and the Nordics', lively: true, foreign: true, queries: [both({ with_genres: String(DOCUMENTARY), with_origin_country: anyOf('NO', 'DK', 'FI', 'IS') })] },
  // History and society
  { id: 'history', name: 'History', group: 'History and society', queries: [
    { movie: { with_genres: `${DOCUMENTARY},${HISTORY}` }, tv: { with_genres: String(DOCUMENTARY), with_keywords: String(KW.history) } },
  ] },
  { id: 'svt-history', name: 'History on SVT Play', group: 'History and society', svt: 'historia' },
  { id: 'war', name: 'War', group: 'History and society', queries: [
    { movie: { with_genres: `${DOCUMENTARY},${WAR}` }, tv: { with_genres: `${DOCUMENTARY},${TV_WAR}` } },
    keywords(KW.worldWar2, KW.coldWar, KW.espionage),
  ] },
  { id: 'royals', name: 'Royals', group: 'History and society', queries: [keywords(KW.royal)] },
  { id: 'politics', name: 'Politics and society', group: 'History and society', queries: [keywords(KW.politics, KW.humanRights, KW.poverty, KW.terrorism)] },
  { id: 'svt-society', name: 'Society on SVT Play', group: 'History and society', svt: 'samhalle' },
  { id: 'money', name: 'Money and business', group: 'History and society', queries: [keywords(KW.finance, KW.economy)] },
  { id: 'religion', name: 'Religion', group: 'History and society', queries: [keywords(KW.religion)] },
  // Nature and science
  { id: 'nature', name: 'Nature and animals', group: 'Nature and science', queries: [keywords(KW.nature, KW.natureDoc, KW.animalsNature, KW.wildlife, KW.animal, KW.ocean)] },
  { id: 'svt-nature', name: 'Nature on SVT Play', group: 'Nature and science', svt: 'djur-och-natur' },
  { id: 'climate', name: 'Climate and environment', group: 'Nature and science', queries: [keywords(KW.climate, KW.environment)] },
  { id: 'disasters', name: 'Disasters', group: 'Nature and science', queries: [keywords(KW.disaster)] },
  { id: 'science', name: 'Science and medicine', group: 'Nature and science', queries: [keywords(KW.science, KW.medicine, KW.psychology, KW.health)] },
  { id: 'svt-science', name: 'Science on SVT Play', group: 'Nature and science', svt: 'vetenskap' },
  { id: 'technology', name: 'Technology', group: 'Nature and science', queries: [keywords(KW.technology)] },
  { id: 'space', name: 'Space', group: 'Nature and science', queries: [keywords(KW.space)] },
  { id: 'dinosaurs', name: 'Dinosaurs', group: 'Nature and science', queries: [keywords(KW.dinosaur)] },
  // Culture and people
  { id: 'biography', name: 'Portraits', group: 'Culture and people', queries: [keywords(KW.biography)] },
  { id: 'music', name: 'Music', group: 'Culture and people', queries: [
    { movie: { with_genres: `${DOCUMENTARY},${MUSIC}` }, tv: { with_genres: String(DOCUMENTARY), with_keywords: String(KW.music) } },
  ] },
  { id: 'svt-culture', name: 'Culture and music on SVT Play', group: 'Culture and people', svt: 'kultur-och-musikdokumentarer' },
  { id: 'art', name: 'Art, design and fashion', group: 'Culture and people', queries: [keywords(KW.art, KW.architecture, KW.fashion)] },
  { id: 'sport', name: 'Sport', group: 'Culture and people', queries: [keywords(KW.sports, KW.motorsport)] },
  { id: 'food', name: 'Food', group: 'Culture and people', queries: [keywords(KW.food)] },
  { id: 'travel', name: 'Travel and adventure', group: 'Culture and people', queries: [keywords(KW.travel, KW.adventure)] },
];

// What the page opens with; the others load as they scroll into view.
export const HOME_ROWS = ['svt-true-crime', 'swedish-true-crime', 'svt-series', 'true-crime'];
// In English the page is English-language only: no SVT Play, Swedish or Nordic rows, and every TMDB row
// asks for titles originally in English (with_original_language). Swedish keeps everything.
export const HOME_ROWS_EN = ['true-crime', 'cold-cases', 'nature', 'history'];
export const swedishContent = (c) => Boolean(c.svt || c.swedish);
export const nonEnglishContent = (c) => swedishContent(c) || Boolean(c.foreign);

const SORTS = {
  popular: {
    movie: { sort_by: 'popularity.desc' }, tv: { sort_by: 'popularity.desc' },
    votes: { normal: '3', lively: null }, by: (t) => t.popularity,
  },
  rating: {
    movie: { sort_by: 'vote_average.desc' }, tv: { sort_by: 'vote_average.desc' },
    votes: { normal: '25', lively: '3' }, by: (t) => t.rating || 0,
  },
  newest: {
    movie: { sort_by: 'primary_release_date.desc' }, tv: { sort_by: 'first_air_date.desc' },
    votes: { normal: '3', lively: null }, by: (t) => t.date || '',
  },
};

// The TMDB parameters for one query of a category. Exported for the tests.
export function discoverParams(category, query, type, sort, page, today, { englishOnly = false } = {}) {
  const params = query[type];
  if (!params) return null;
  const order = SORTS[sort] || SORTS.popular;
  const votes = category.lively ? order.votes.lively : order.votes.normal;
  return {
    ...params,
    ...order[type],
    ...(votes ? { 'vote_count.gte': votes } : {}),
    ...(type === 'tv' && !params.with_keywords ? { without_genres: anyOf(NEWS, TALK, SOAP) } : {}),
    ...(englishOnly ? { with_original_language: 'en' } : {}),
    include_adult: 'false',
    page: String(page),
    [type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte']: today,
  };
}

// Answers from several queries as one list: each title once, in the sort's order.
export function mergeResults(lists, sort) {
  const by = (SORTS[sort] || SORTS.popular).by;
  const seen = new Set(), out = [];
  for (const t of lists.flat()) {
    const key = `${t.type}:${t.id}`;
    if (seen.has(key) || !(t.poster || t.backdrop)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => (by(b) > by(a) ? 1 : by(b) < by(a) ? -1 : 0));
}

// deps: { tmdb(endpoint, params) (cached), mapTitle(raw, type), svtCategory(slug), svtOn(), translate(text) }
export function createDocumentaries(deps) {
  const english = () => (deps.language?.() || 'en') !== 'sv';
  // Page order. English leaves out the Swedish and other non-English rows altogether.
  const visible = () => {
    const cats = CATEGORIES.filter((c) => !c.svt || deps.svtOn());
    return english() ? cats.filter((c) => !nonEnglishContent(c)) : cats;
  };

  const publicCategory = (c) => ({
    id: c.id, name: deps.translate(c.name), group: deps.translate(c.group), source: c.svt ? 'svt' : 'tmdb',
  });

  async function category(id, { type = 'all', sort = 'popular', page = 1 } = {}) {
    const c = visible().find((x) => x.id === id);
    if (!c) return null;
    if (c.svt) {
      const { items } = page === 1 ? await deps.svtCategory(c.svt) : { items: [] };
      const wanted = type === 'movie' ? items.filter((t) => t.kind === 'film') : type === 'tv' ? items.filter((t) => t.kind === 'series') : items;
      return { id, title: deps.translate(c.name), source: 'svt', results: wanted, page, totalPages: 1 };
    }
    const today = new Date().toISOString().slice(0, 10);
    const types = type === 'movie' ? ['movie'] : type === 'tv' ? ['tv'] : ['movie', 'tv'];
    const answers = await Promise.all(c.queries.flatMap((query) => types.map(async (t) => {
      const params = discoverParams(c, query, t, sort, page, today, { englishOnly: english() });
      if (!params) return null;
      const data = await deps.tmdb(`/discover/${t}`, params);
      return { results: (data.results || []).map((x) => deps.mapTitle(x, t)), totalPages: Math.min(data.total_pages || 1, 500) };
    })));
    return {
      id, title: deps.translate(c.name), source: 'tmdb',
      results: mergeResults(answers.map((a) => a?.results || []), sort),
      page, totalPages: Math.max(1, ...answers.map((a) => a?.totalPages || 0)),
    };
  }

  async function home() {
    const cats = visible();
    const first = (english() ? HOME_ROWS_EN : HOME_ROWS).filter((id) => cats.some((c) => c.id === id));
    const answers = await Promise.all(first.map((id) => category(id).catch(() => null)));
    const rows = answers.filter((a) => a?.results.length)
      .map((a) => ({ id: a.id, title: a.title, source: a.source, items: a.results }));
    const featured = rows.flatMap((r) => r.items).filter((t) => t.backdrop && t.overview && !(english() && t.type === 'svt')).slice(0, 6);
    return {
      featured,
      categories: cats.map(publicCategory),
      rows,
      // The rest of the rows, in page order, for the page to load as they come near.
      more: cats.filter((c) => !first.includes(c.id)).map((c) => ({ id: c.id, title: deps.translate(c.name), source: c.svt ? 'svt' : 'tmdb' })),
    };
  }

  return { home, category };
}
