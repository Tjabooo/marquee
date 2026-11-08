// Stills for video notes, kept as light on the server as possible. A video is only requested while
// it's on screen, its download is dropped if it scrolls away first, and once the first frame is in
// hand that frame moves to a canvas and the video lets go of the file.

const MAX_SIDE = 1280; // sharp enough at the size notes show them, without holding 4K frames in memory

const release = (video) => { video.removeAttribute('src'); video.load(); };

function frameToCanvas(video, doc) {
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = doc.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

export function createStills({ Observer = globalThis.IntersectionObserver, doc = globalThis.document } = {}) {
  const sources = new WeakMap();
  const observer = Observer && new Observer((entries) => {
    for (const { target: video, isIntersecting } of entries) {
      if (isIntersecting) { if (!video.hasAttribute('src')) video.src = sources.get(video); }
      else if (video.hasAttribute('src')) release(video);
      if (!video.isConnected) observer.unobserve(video);
    }
  });

  // Starts showing `src`'s frame in `video`. Without IntersectionObserver it just loads straight away.
  return function showStill(video, src) {
    if (!observer) { video.src = src; return; }
    sources.set(video, src);
    const capture = () => {
      if (!video.hasAttribute('src') || !video.videoWidth || video.seeking) return; // `#t=` seeks first: wait for it
      let canvas;
      try { canvas = frameToCanvas(video, doc); } catch { return; } // keep the video element's own frame
      observer.unobserve(video);
      video.replaceWith(canvas);
      release(video);
    };
    video.addEventListener('loadeddata', capture);
    video.addEventListener('seeked', capture);
    video.addEventListener('error', () => { if (video.hasAttribute('src')) observer.unobserve(video); }); // can't play here: don't retry on every scroll
    observer.observe(video);
  };
}
