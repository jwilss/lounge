/*
 * Continue watching for websites.
 * When a video has played large on screen for a while, tell the box what it
 * was (page, title, artwork, how far through). Trailers and small previews
 * are ignored. Nothing leaves the box: it only talks to lounged on 127.0.0.1.
 */
(function () {
  'use strict';
  if (window.top !== window || window.__loungeRecorder) return;
  window.__loungeRecorder = true;
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return;

  const CHECK_MS = 5000;
  const MIN_WATCHED_S = 45;   // must play this long before it counts
  const MIN_LENGTH_S = 150;   // skip short clips and trailers
  const MIN_SCREEN = 0.55;    // video must cover most of the screen
  const REPORT_EVERY_MS = 30000;

  let watched = 0;
  let pageKey = '';
  let lastReport = 0;

  function mainVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
                   Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area > bestArea) { bestArea = area; best = v; }
    }
    if (document.fullscreenElement && document.fullscreenElement.querySelector) {
      const fv = document.fullscreenElement.tagName === 'VIDEO' ? document.fullscreenElement : document.fullscreenElement.querySelector('video');
      if (fv) return { v: fv, share: 1 };
    }
    return best ? { v: best, share: bestArea / (innerWidth * innerHeight) } : null;
  }

  function meta(name) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
  }

  function details(v) {
    let title = '', subtitle = '', image = '';
    try {
      const m = navigator.mediaSession && navigator.mediaSession.metadata;
      if (m) {
        title = m.title || '';
        subtitle = m.artist || m.album || '';
        const art = [...(m.artwork || [])].sort((a, b) => (parseInt(b.sizes, 10) || 0) - (parseInt(a.sizes, 10) || 0));
        if (art[0]) image = new URL(art[0].src, location.href).href;
      }
    } catch (e) { /* not available in this page */ }
    title = title || meta('og:title') || document.title || '';
    image = image || meta('og:image') || v.poster || '';
    return { title: title.trim(), subtitle: subtitle.trim(), image: image.startsWith('https://') ? image : '' };
  }

  function report(v) {
    const d = details(v);
    const msg = {
      type: 'lounge-recent',
      body: {
        url: location.href,
        title: d.title,
        subtitle: d.subtitle,
        image: d.image,
        progress: v.duration ? v.currentTime / v.duration : 0,
      },
    };
    try { chrome.runtime.sendMessage(msg); } catch (e) { /* extension reloaded */ }
    lastReport = Date.now();
  }

  setInterval(() => {
    const m = mainVideo();
    const key = location.href.split('#')[0] + '#' + (location.hash || '');
    if (key !== pageKey) { pageKey = key; watched = 0; }
    if (!m) return;
    const { v, share } = m;
    const playing = !v.paused && !v.ended && v.readyState > 2;
    const longEnough = !isFinite(v.duration) || v.duration >= MIN_LENGTH_S; // live streams have no end
    if (!playing || !longEnough || share < MIN_SCREEN) return;
    watched += CHECK_MS / 1000;
    if (watched >= MIN_WATCHED_S && Date.now() - lastReport > REPORT_EVERY_MS) report(v);
  }, CHECK_MS);

  // save the final position when leaving the page
  window.addEventListener('pagehide', () => {
    const m = mainVideo();
    if (m && watched >= MIN_WATCHED_S) report(m.v);
  });
})();
