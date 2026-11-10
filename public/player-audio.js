// A stream index belongs only to the file fingerprint returned with it.
import { T, lang } from './i18n.js';
const languageAliases = { eng: 'en', kor: 'ko', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', jpn: 'ja', zho: 'zh', chi: 'zh', por: 'pt', rus: 'ru', ara: 'ar', nld: 'nl', dut: 'nl', geo: 'ka', kat: 'ka', tgl: 'tl', fil: 'tl' };
export const audioLanguage = (value) => {
  const code = String(value || '').trim().toLowerCase();
  return !code || ['und', 'mul', 'zxx'].includes(code) ? '' : languageAliases[code] || code;
};
const clean = (value) => String(value || '').trim().toLowerCase();
export function audioChoices(tracks) {
  let names;
  try { names = new Intl.DisplayNames([lang], { type: 'language' }); } catch { /* older browser */ }
  const languageName = (track) => {
    const code = audioLanguage(track.language);
    try { const label = code && names?.of(code); return label && label !== code ? label : ''; } catch { return ''; }
  };
  const languages = tracks.map(t => audioLanguage(t.language));
  const labels = tracks.map((track, i) => {
    const language = languageName(track);
    const title = String(track.title || '').trim();
    const parts = [language || T('Track {0}', track.audioIndex + 1)];
    if (title && ![clean(language), clean(track.language), 'soundhandler'].includes(clean(title))) parts.push(title);
    if (languages.filter(l => l === languages[i]).length > 1) {
      const channels = { 1: T('Mono'), 2: T('Stereo'), 6: '5.1', 8: '7.1' }[track.channels] || (track.channels ? T('{0} channels', track.channels) : '');
      if (channels && !clean(title).includes(clean(channels))) parts.push(channels);
    }
    return parts.join(' · ');
  });
  return tracks.map((track, i) => {
    let label = labels[i];
    if (labels.filter(x => x === label).length > 1) label += track.codec ? ` · ${String(track.codec).toUpperCase()}` : '';
    if (tracks.some((other, j) => j !== i && labels[j] === labels[i] && other.codec === track.codec)) label += T(' · Track {0}', track.audioIndex + 1);
    return { ...track, label };
  });
}

// AudioTrackList order alone is insufficient: converted files can insert/reorder audio.
// Verify the complete served-file mapping. Duplicate languages need unique titles or real IDs.
export function nativeAudioMapping(tracks, nativeTracks) {
  if (!nativeTracks || nativeTracks.length !== tracks.length || !tracks.length) return null;
  const sorted = [...tracks].sort((a, b) => a.audioIndex - b.audioIndex);
  const streamId = value => {
    const text = clean(value);
    return /^(?:0x[0-9a-f]+|\d+)$/.test(text) ? String(Number(text)) : text;
  };
  const mapping = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const track = sorted[i], native = nativeTracks[i];
    if (track.audioIndex !== i || !native || !('enabled' in native)) return null;
    const language = audioLanguage(track.language), nativeLanguage = audioLanguage(native.language);
    if (nativeLanguage && language && nativeLanguage !== language) return null;
    const id = streamId(track.streamId), nativeId = streamId(native.id);
    const matchingId = Boolean(id && nativeId && id === nativeId);
    if (id && nativeId && !matchingId) return null;
    const title = clean(track.title), label = clean(native.label);
    const uniqueLanguage = language && tracks.filter(t => audioLanguage(t.language) === language).length === 1;
    const uniqueTitle = title && label === title && tracks.filter(t => clean(t.title) === title).length === 1;
    if (!matchingId && !(nativeLanguage === language && (uniqueLanguage || uniqueTitle))) return null;
    mapping.set(track.index, native);
  }
  return mapping;
}

// The same audio in another copy of the video (converting can add, drop or reorder tracks): the same language,
// then the closest codec, channel count, title and position. null when that language isn't there.
export function sameAudio(track, tracks) {
  const language = audioLanguage(track.language);
  const score = t => (t.codec === track.codec) * 8 + (t.channels === track.channels) * 4 + (clean(t.title) === clean(track.title)) * 2 + (t.audioIndex === track.audioIndex);
  return tracks.filter(t => audioLanguage(t.language) === language).sort((a, b) => score(b) - score(a))[0] || null;
}
