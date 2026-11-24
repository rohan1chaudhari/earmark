// Capture: hotkey or player button -> press record -> background.
// Never pauses playback, never takes focus.
(() => {
  // When the extension is reloaded or updated, the copy of this script in
  // tabs that are already open goes dead: its buttons stay but can no longer
  // reach the extension. The background worker then injects a fresh copy,
  // which takes over here and removes what the dead one left behind.
  if (window.__earmarkContent && chrome.runtime?.id && window.__earmarkContent === chrome.runtime.id + ':live') {
    try { chrome.runtime.getURL(''); return; } catch {}
  }
  window.__earmarkContent = chrome.runtime.id + ':live';
  document.querySelectorAll('.earmark-btn, .earmark-card').forEach((n) => n.remove());

  const DOUBLE_PRESS_MS = 2000;
  let seq = 0;
  const waiting = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__earmark !== 'reply') return;
    const resolve = waiting.get(ev.data.id);
    if (resolve) {
      waiting.delete(ev.data.id);
      resolve(ev.data.payload);
    }
  });

  function askPage(kind, extra = {}, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const id = `em${Date.now()}_${seq++}`;
      waiting.set(id, resolve);
      window.postMessage({ __earmark: 'request', id, kind, ...extra }, location.origin);
      setTimeout(() => {
        if (waiting.delete(id)) resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
    });
  }

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
  };

  // ---- indicator ----
  // One card, top centre of the window, that confirms the press and then
  // follows the note being made. Styled inline and animated with the Web Animations
  // API, so nothing is added to YouTube's stylesheets.
  const ACCENT = '#ff7a45';
  const ui = {};
  let hideTimer = null;
  let activeId = null; // the press the card is currently following

  function buildIndicator() {
    const NS = 'http://www.w3.org/2000/svg';
    const css = (node, text) => { node.style.cssText = text; return node; };
    ui.box = css(document.createElement('div'),
      'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:2147483647;display:none;' +
      'align-items:center;gap:14px;width:max-content;max-width:min(520px,calc(100vw - 32px));padding:12px 20px 12px 12px;' +
      'border-radius:16px;background:rgba(16,16,16,.94);color:#fff;text-align:left;' +
      'font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      `box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.1),inset 0 0 0 1px ${ACCENT}55;` +
      'backdrop-filter:blur(10px);pointer-events:none;user-select:none');
    ui.box.className = 'earmark-card';
    ui.box.setAttribute('role', 'status');
    ui.box.setAttribute('aria-live', 'polite');

    const badge = css(document.createElement('div'), 'position:relative;flex:none;width:44px;height:44px');
    ui.ring = css(document.createElement('div'),
      `position:absolute;inset:0;border-radius:50%;border:3px solid rgba(255,255,255,.14);border-top-color:${ACCENT}`);
    ui.dot = css(document.createElement('div'),
      `position:absolute;inset:6px;border-radius:50%;background:${ACCENT};display:grid;place-items:center`);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    ui.glyph = document.createElementNS(NS, 'path');
    ui.glyph.setAttribute('fill', '#fff');
    svg.appendChild(ui.glyph);
    ui.dot.appendChild(svg);
    badge.append(ui.ring, ui.dot);

    const text = css(document.createElement('div'), 'min-width:0');
    ui.title = css(document.createElement('div'), 'font-size:16px;font-weight:650;letter-spacing:-.01em');
    ui.sub = css(document.createElement('div'),
      'font-size:13.5px;color:rgba(255,255,255,.72);margin-top:2px;overflow:hidden;text-overflow:ellipsis;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical');
    text.append(ui.title, ui.sub);
    ui.box.append(badge, text);
    ui.box.addEventListener('click', () => { if (ui.onClick) ui.onClick(); });
    ui.spin = ui.ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity });
  }

  const GLYPHS = {
    mark: 'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z',
    done: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z',
    warn: 'M11 6h2v8h-2zm0 10h2v2h-2z',
  };

  // state: 'busy' (spinner, stays), 'done', 'info', 'error' (these three fade out after `ms`).
  function indicate({ title, sub = '', state = 'info', ms = 4000, onClick = null, pop = false }) {
    if (!ui.box) buildIndicator();
    // Pinned to the window, just under YouTube's top bar, so it shows however
    // the page is scrolled. In fullscreen only the fullscreen element is drawn,
    // so the card moves inside it.
    const full = document.fullscreenElement;
    const host = full || document.documentElement;
    if (ui.box.parentNode !== host) host.appendChild(ui.box);
    ui.box.style.top = full ? '28px' : '72px';

    const colour = state === 'error' ? '#ff5d52' : state === 'done' ? '#3ecf7a' : ACCENT;
    ui.title.textContent = title;
    ui.sub.textContent = sub;
    ui.sub.style.display = sub ? '-webkit-box' : 'none';
    ui.dot.style.background = colour;
    ui.glyph.setAttribute('d', GLYPHS[state === 'done' ? 'done' : state === 'error' ? 'warn' : 'mark']);
    ui.ring.style.borderTopColor = colour;
    ui.ring.style.opacity = state === 'busy' ? '1' : '0';
    if (state === 'busy') ui.spin.play(); else ui.spin.pause();
    ui.onClick = onClick;
    ui.box.style.pointerEvents = onClick ? 'auto' : 'none';
    ui.box.style.cursor = onClick ? 'pointer' : 'default';

    const wasHidden = ui.box.style.display === 'none';
    ui.box.style.display = 'flex';
    if (ui.fade) { ui.fade.cancel(); ui.fade = null; }
    if (wasHidden) {
      ui.box.animate(
        [{ opacity: 0, transform: 'translate(-50%,-18px) scale(.94)' }, { opacity: 1, transform: 'translate(-50%,0) scale(1)' }],
        { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.25)' });
    }
    if (pop || wasHidden) {
      ui.dot.animate([{ transform: 'scale(.5)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'ease-out' });
    }
    clearTimeout(hideTimer);
    // A busy card stays until the next update; the cap covers a lost update.
    hideTimer = setTimeout(hideIndicator, state === 'busy' ? 150000 : ms);
  }

  function hideIndicator() {
    if (!ui.box || ui.box.style.display === 'none') return;
    ui.fade = ui.box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in' });
    ui.fade.onfinish = () => { ui.box.style.display = 'none'; ui.fade = null; };
  }

  const openLibrary = () => chrome.runtime.sendMessage({ type: 'earmark:open-library' });

  // News about the latest press, sent by the background worker.
  function onStatus(msg) {
    if (msg.id !== activeId) return;
    // Normal progress is shown in the Earmark library and on the toolbar
    // icon, not here: the video tab only hears back when something needs
    // attention.
    if (msg.stage === 'no-captions') indicate({ title: 'No captions on this video', sub: 'The position is saved, but there is no note.', state: 'info', ms: 6000, onClick: openLibrary });
    else if (msg.stage === 'queued') indicate({ title: 'Kept for later', sub: msg.message, state: 'info', ms: 8000, onClick: openLibrary });
    else if (msg.stage === 'error') indicate({ title: 'Could not make the note', sub: msg.message, state: 'error', ms: 9000, onClick: openLibrary });
  }

  // ---- press handling ----
  let open = null; // the press still inside its double-press window

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const currentVideo = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);

  // Captions sometimes cannot be read at the moment of the press (the player
  // is still starting, or an ad is in the way). Keep trying while this video
  // is open, and hand the transcript over when it arrives.
  const fetching = new Set();
  async function deliverTranscript(videoId, delays = [4000, 10000, 25000, 60000]) {
    if (fetching.has(videoId)) return;
    fetching.add(videoId);
    try {
      for (const delay of delays) {
        await sleep(delay);
        if (currentVideo() !== videoId) return;
        const r = await askPage('transcript', { videoId });
        if (r && r.ok && r.transcript) {
          chrome.runtime.sendMessage({ type: 'earmark:transcript', media_id: videoId, transcript: r.transcript });
          return;
        }
        if (r && r.reason === 'none') {
          chrome.runtime.sendMessage({ type: 'earmark:transcript', media_id: videoId, transcript: null });
          return;
        }
      }
    } finally {
      fetching.delete(videoId);
    }
  }

  async function send(press) {
    // Reading captions can take a few seconds the first time on a video; the
    // press itself is already fixed, so this never delays the toast.
    const r = await askPage('transcript', { videoId: press.media_id });
    const transcript = r && r.ok ? r.transcript : null;
    const none = !!(r && r.reason === 'none');
    chrome.runtime.sendMessage({ type: 'earmark:press', press, transcript, no_captions: none });
    if (!transcript && !none) deliverTranscript(press.media_id);
  }

  // Coming back to a video that still has a press waiting for its captions.
  let lastVideo = null;
  function checkPending() {
    const videoId = currentVideo();
    if (videoId === lastVideo) return;
    lastVideo = videoId;
    if (!videoId) return;
    chrome.runtime.sendMessage({ type: 'earmark:pending', media_id: videoId }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.pending) deliverTranscript(videoId, [3000, 8000, 20000]);
    });
  }

  // The shortcut can arrive twice for one key press: once from Chrome's own
  // shortcut and once from the key listener below. Count it once.
  let lastTrigger = 0;
  function trigger() {
    const now = Date.now();
    if (now - lastTrigger < 350) return;
    lastTrigger = now;
    onPress();
  }

  // Option/Alt+B directly on the page, so the shortcut works even when Chrome
  // has not assigned it (see chrome://extensions/shortcuts).
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (location.pathname !== '/watch') return;
    e.preventDefault();
    e.stopPropagation();
    trigger();
  }, true);

  async function onPress() {
    if (open) {
      // Second press inside the window: a note on the whole video.
      clearTimeout(open.timer);
      open.press.width = 'full';
      indicate({ title: 'Earmarked the whole video', sub: 'One note for all of it', state: 'info', ms: 2200, pop: true });
      const p = open.press;
      open = null;
      send(p);
      return;
    }
    const snap = await askPage('snapshot', {}, 2000);
    if (!snap || !snap.ok) {
      indicate(snap && snap.reason === 'ad'
        ? { title: 'Ad playing', sub: 'Nothing was bookmarked.', state: 'error', ms: 2500 }
        : { title: 'Nothing to bookmark here', state: 'error', ms: 2500 });
      return;
    }
    if (snap.isLive) {
      indicate({ title: 'Live streams are not supported yet', state: 'error', ms: 3000 });
      return;
    }
    const now = new Date();
    const press = {
      id: `${now.toISOString().replace(/[:.]/g, '-')}-${snap.videoId.slice(0, 4)}`,
      source: 'youtube',
      media_id: snap.videoId,
      url: `https://www.youtube.com/watch?v=${snap.videoId}`,
      t_press: snap.t,
      width: 'normal',
      pressed_at: now.toISOString(),
      title: snap.title,
      channel: snap.channel,
      description: snap.description,
      duration: snap.duration,
    };
    activeId = press.id;
    indicate({ title: `Earmarked ${fmt(press.t_press)}`, sub: 'Press again for the whole video', state: 'info', ms: 2600 });
    open = {
      press,
      timer: setTimeout(() => {
        const p = open.press;
        open = null;
        send(p);
      }, DOUBLE_PRESS_MS),
    };
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'earmark:hotkey') trigger();
    else if (msg && msg.type === 'earmark:status') onStatus(msg);
  });

  // ---- player button ----
  function ensureButton() {
    if (location.pathname !== '/watch') return;
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls || controls.querySelector('.earmark-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'ytp-button earmark-btn';
    btn.title = 'Earmark this moment (Alt+B)';
    btn.setAttribute('aria-label', 'Earmark this moment');
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;vertical-align:top';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      trigger();
    });
    controls.insertBefore(btn, controls.firstChild);
  }
  setInterval(() => { ensureButton(); checkPending(); }, 2000);
  ensureButton();
  checkPending();
})();
