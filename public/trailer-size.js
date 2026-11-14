// YouTube picks a trailer's quality from how big its player is in CSS pixels, and our players are small
// (a ~900 px frame on a title page gets 480p, a phone 360p). So the iframe is laid out at full-HD size or
// more and scaled down to fit its box: YouTube sees a 1920 px player and streams 1080p, the screen gets
// a sharp downscale. `cover` fills the box (cropping the sides or the top and bottom) instead of fitting.
const HD = 1920;

export function fitTrailer(frame, box, { cover = false, zoom = 1 } = {}) {
  frame.style.position = 'absolute';
  frame.style.left = frame.style.top = '50%';
  frame.style.transformOrigin = '50% 50%';
  const size = () => {
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    const w = (cover ? Math.max(bw, bh * 16 / 9) : Math.min(bw, bh * 16 / 9)) * zoom; // shown width
    const base = Math.max(HD, Math.ceil(w)); // laid-out width YouTube sees
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
