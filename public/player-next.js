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

// ---- Play on TV ----
// The TV can't show Marquee's buttons, so the phone's remote shows them instead. All it knows is what the
// TV reports every poll (state, position, duration), so the cues come from that position: Skip intro
// while the opening titles play, Up next from the credits start, or once the TV finished the episode.
export const TV_END_SLACK = 10; // seconds: a TV that stops this close to the end has played the episode to its end

export function tvIntroShowing({ state, position, intro }) {
  if (!intro || !Number.isFinite(position) || !['playing', 'paused', 'loading'].includes(state)) return false;
  return position >= intro.start - 0.5 && position < intro.end - 1.5; // polled position: stop offering it just before the end
}

// lastPosition is the last position the TV reported while it was still playing.
export function tvFinished({ state, lastPosition, duration }) {
  return state === 'stopped' && Number.isFinite(duration) && duration > 0
    && Number.isFinite(lastPosition) && lastPosition >= duration - TV_END_SLACK;
}

export function tvNextShowing({ state, position, duration, creditsAt, lastPosition }) {
  if (tvFinished({ state, lastPosition, duration })) return true;
  if (!['playing', 'paused'].includes(state)) return false;
  return isNextEpisodeTime({ ended: false, time: position, duration, creditsAt });
}
