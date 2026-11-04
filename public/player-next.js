// Playback order comes from the signed-in person's completed library, never torrent progress.
const positiveInteger = (n) => Number.isSafeInteger(n) && n > 0;
const usableEpisode = (f) => Boolean(f?.id && f.show && positiveInteger(f.season) && positiveInteger(f.episode)
  && !f.converting && f.done !== false);

export function nextLibraryEpisode(playing, library, shows) {
  if (playing?.kind !== 'lib') return null;
  // Group IDs can change when a delayed TMDB lookup resolves. Resolve the current file afresh.
  const current = library.find((f) => f.id === (playing.id || playing.key));
  if (!usableEpisode(current)) return null;
  const episodes = library.filter((f) => usableEpisode(f) && f.show === current.show);
  const choose = (season, episode) => episodes.filter((f) => f.season === season && f.episode === episode)
    .sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')) || String(a.id).localeCompare(String(b.id)))[0] || null;
  const next = choose(current.season, current.episode + 1);
  if (next) return next;
  const total = shows.find((s) => s.id === current.show)?.seasons?.find((s) => s.number === current.season)?.total;
  // The last downloaded episode is not evidence of a season finale. Never skip a missing episode.
  return positiveInteger(total) && current.episode === total ? choose(current.season + 1, 1) : null;
}

// The prompt (and its countdown) starts exactly where the closing credits start: an ending chapter, or
// the closing-credits music found by comparing episodes (server credits.js). No guessed end window:
// when the credits start is unknown, the prompt waits for the real end of the file.
export const AUTOPLAY_SECONDS = 10;
export const AUTOPLAY_CHAIN = 3; // auto-played episodes in a row before it waits for a person again

export function nextEpisodePromptAt(duration, creditsAt) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Number.isFinite(creditsAt) && creditsAt > duration / 2 && creditsAt < duration ? creditsAt : null;
}

export function isNextEpisodeTime({ ended, time, duration, creditsAt }) {
  if (ended) return true;
  const promptAt = nextEpisodePromptAt(duration, creditsAt);
  return promptAt !== null && Number.isFinite(time) && time >= promptAt;
}
