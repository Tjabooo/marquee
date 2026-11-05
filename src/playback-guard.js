// While someone is watching, downloads make room for them. A torrent writing at full speed to the
// media drive scatters small writes all over it and a player's reads queue up behind them (on a
// hard drive one 4 MB read can then take seconds). So when the first stream starts, Marquee
// switches qBittorrent to its alternative speed limits (set them in qBittorrent: Options → Speed →
// Alternative rate limits), and switches back once nobody has streamed for a while. If the
// alternative limits were already on (turned on by hand or by qBittorrent's scheduler), Marquee
// leaves them alone and never turns them off.
//
//   QBIT_PLAYBACK_LIMITS        on (default) | off
//   PLAYBACK_IDLE_SECONDS       how long after the last stream to restore full speed (default 60)
import fs from 'node:fs';

export function startPlaybackGuard({ watching, qbit, stateFile = null, intervalMs = 5000, log = console.log } = {}) {
  const enabled = Boolean(qbit) && String(process.env.QBIT_PLAYBACK_LIMITS || 'on').toLowerCase() !== 'off';
  const idleMs = Math.max(0, Number(process.env.PLAYBACK_IDLE_SECONDS ?? 60)) * 1000;
  // `ours` = Marquee turned the alternative limits on and must turn them off again. Saved, so a
  // restart in the middle of a film doesn't leave qBittorrent slow forever.
  let ours = false;
  try { ours = JSON.parse(fs.readFileSync(stateFile, 'utf8')).qbitAlt === true; } catch { /* none */ }
  let lastWatched = 0;
  let busy = false;
  const save = () => { if (stateFile) { try { fs.writeFileSync(stateFile, JSON.stringify({ qbitAlt: ours })); } catch { /* kept in memory */ } } };

  const altOn = async () => String(await (await qbit('/api/v2/transfer/speedLimitsMode')).text()).trim() === '1';
  const toggle = () => qbit('/api/v2/transfer/toggleSpeedLimitsMode', { method: 'POST' });

  async function round() {
    if (busy || !enabled) return;
    busy = true;
    try {
      const now = Date.now();
      if (watching()) lastWatched = now;
      const want = lastWatched > 0 && now - lastWatched < idleMs + 1;
      if (want && !ours) {
        if (!(await altOn())) { await toggle(); ours = true; save(); log('[playback] someone is watching: downloads switched to qBittorrent’s alternative speed limits'); }
      } else if (!want && ours) {
        if (await altOn()) await toggle();
        ours = false; save();
        log('[playback] nobody is watching: downloads back to full speed');
      }
    } catch { /* qBittorrent unreachable: try again next round */ }
    finally { busy = false; }
  }
  const timer = setInterval(round, intervalMs);
  timer.unref();
  setTimeout(round, 1000).unref(); // after start-up
  return { round, state: () => ({ enabled, limited: ours, lastWatched }), stop: () => clearInterval(timer) };
}
