// YouTube picks a trailer's quality from how big its player is (in device pixels), and a ~900 px frame on a
// title page got 480p. So the iframe is always laid out as a 1080p player (1920 device pixels wide) and
// scaled to its box. Never bigger: the zoomed banner trailer was laid out ~3400 px wide on a 1440p screen,
// and YouTube then sent 1440p/4K AV1, which Firefox decodes in software on many GPUs and plays choppy.
// `cover` fills the box (cropping the sides or the top and bottom) instead of fitting.
const HD = 1920;

export function fitTrailer(frame, box, { cover = false, zoom = 1 } = {}) {
  frame.style.position = 'absolute';
  frame.style.left = frame.style.top = '50%';
  frame.style.transformOrigin = '50% 50%';
  const size = () => {
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    const w = (cover ? Math.max(bw, bh * 16 / 9) : Math.min(bw, bh * 16 / 9)) * zoom; // shown width
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const base = Math.round(HD / dpr); // laid-out width YouTube sees: 1920 device pixels
    frame.style.width = `${base}px`;
    frame.style.height = `${Math.round(base * 9 / 16)}px`;
    frame.style.transform = `translate(-50%, -50%) scale(${w / base})`;
  };
  size();
  const ro = new ResizeObserver(size);
  ro.observe(box);
  return () => ro.disconnect();
}

// Ask for HD too (YouTube treats it as a hint at best, the player size above is what really counts).
export const HD_HINT = 'vq=hd1080';
