// Runs in the page's own JavaScript world so it can talk to the YouTube player.
// Answers one request from content.js: "what is playing, where, and what is its transcript?"
(() => {
  if (window.__earmarkPage) return;
  window.__earmarkPage = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const transcripts = new Map(); // videoId -> Promise<{lang, kind, segments} | null>
  const noCaptions = new Set(); // videos that declare no caption tracks at all

  const getPlayer = () => document.querySelector('#movie_player');

  function parseJson3(text) {
    const data = JSON.parse(text);
    const segments = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const line = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      segments.push({ s: (ev.tStartMs || 0) / 1000, d: (ev.dDurationMs || 0) / 1000, text: line });
    }
    return segments;
  }

  // Which language the video was actually spoken in. Videos with auto-dubbed
  // audio list auto-generated captions in a dozen languages, and the first
  // one in the list is not the original.
  function originalLanguage(player) {
    try {
      const r = player.getPlayerResponse().captions.playerCaptionsTracklistRenderer;
      const audio = (r.audioTracks || [])[r.defaultAudioTrackIndex ?? 0];
      const idx = audio && audio.defaultCaptionTrackIndex != null ? audio.defaultCaptionTrackIndex : null;
      const track = idx != null ? r.captionTracks[idx] : null;
      if (track) return track.languageCode;
    } catch {}
    return null;
  }

  // Original language first: human-made, then auto-generated. Otherwise any
  // human-made track, then any auto-generated one.
  function pickTrack(tracks, original, showing) {
    if (!tracks.length) return null;
    const base = (c) => String(c || '').split('-')[0];
    const isAsr = (t) => t.kind === 'asr';
    const manual = tracks.filter((t) => !isAsr(t));
    const asr = tracks.filter(isAsr);
    // Without a declared original, a single auto-generated track is the spoken
    // language; failing that, trust what the viewer is already watching with.
    const lang = base(original || (asr.length === 1 ? asr[0].languageCode : showing));
    if (lang) {
      const hit = manual.find((t) => base(t.languageCode) === lang) || asr.find((t) => base(t.languageCode) === lang);
      if (hit) return hit;
    }
    return manual[0] || asr[0] || tracks[0];
  }

  // YouTube only serves captions to its own player (the request carries a
  // token the player mints). So: ask the player to load the track, watch for
  // the request it makes, and read the same URL again as JSON.
  function waitForCaptionUrl(videoId, track, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let observer;
      const finish = (url) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        resolve(url);
      };
      const matches = (name) => {
        if (!name.includes('/api/timedtext')) return false;
        try {
          const u = new URL(name);
          if (u.searchParams.get('v') !== videoId) return false;
          if (u.searchParams.get('tlang')) return false; // a translation, not the track itself
          if (u.searchParams.get('lang') !== track.languageCode) return false;
          return (u.searchParams.get('kind') === 'asr') === (track.kind === 'asr');
        } catch {
          return false;
        }
      };
      observer = new PerformanceObserver((list) => {
        const hit = list.getEntries().find((e) => matches(e.name));
        if (hit) finish(hit.name);
      });
      observer.observe({ type: 'resource', buffered: true });
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  async function loadTranscript(videoId) {
    const player = getPlayer();
    if (!player || !player.getOption) return null;

    // Right after a video starts, the player may not have its caption list
    // yet. Only conclude "no captions" when the video itself declares none.
    let declared = null;
    try {
      const list = player.getPlayerResponse().captions?.playerCaptionsTracklistRenderer?.captionTracks;
      declared = Array.isArray(list) ? list.length : 0;
    } catch {}
    let tracks = [];
    for (let i = 0; i < 30; i++) {
      try { player.loadModule && player.loadModule('captions'); } catch {}
      // Auto-generated tracks are left out of the list unless asked for.
      try { tracks = player.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch {}
      if (tracks.length || declared === 0) break;
      await sleep(200);
    }
    let before = null;
    try { before = player.getOption('captions', 'track'); } catch {}
    const track = pickTrack(tracks, originalLanguage(player), before && before.languageCode);
    if (!track) {
      if (declared === 0) noCaptions.add(videoId);
      return null;
    }

    const wasOn = !!(before && before.languageCode);

    // If this exact track is already showing, the player will not request it
    // again on its own, so only check briefly for an earlier request.
    const sameShowing = wasOn && before.languageCode === track.languageCode &&
      (before.kind === 'asr') === (track.kind === 'asr');
    let pending = waitForCaptionUrl(videoId, track, sameShowing ? 400 : 2500);
    try { player.setOption('captions', 'track', track); } catch {}
    let url = await pending;
    if (!url) {
      // Already showing this track and the earlier request is gone: reload it.
      pending = waitForCaptionUrl(videoId, track, 4000);
      try {
        player.setOption('captions', 'track', {});
        await sleep(150);
        player.setOption('captions', 'track', track);
      } catch {}
      url = await pending;
    }

    // Put the viewer's captions back the way they were.
    try {
      if (wasOn) player.setOption('captions', 'track', before);
      else player.setOption('captions', 'track', {});
    } catch {}

    if (!url) return null;
    const u = new URL(url);
    u.searchParams.set('fmt', 'json3');
    const res = await fetch(u.toString());
    if (!res.ok) return null;
    const segments = parseJson3(await res.text());
    if (!segments.length) return null;
    return { lang: track.languageCode, kind: track.kind === 'asr' ? 'auto' : 'manual', segments };
  }

  function getTranscript(videoId) {
    if (!transcripts.has(videoId)) {
      const p = loadTranscript(videoId).catch(() => null);
      transcripts.set(videoId, p);
      // A failed load should be retried on the next press, not remembered.
      p.then((t) => { if (!t) transcripts.delete(videoId); });
    }
    return transcripts.get(videoId);
  }

  function snapshot() {
    const player = getPlayer();
    if (!player || !player.getVideoData) return { ok: false, reason: 'no-player' };
    const data = player.getVideoData() || {};
    const videoId = data.video_id;
    if (!videoId) return { ok: false, reason: 'no-video' };
    if (player.classList.contains('ad-showing')) return { ok: false, reason: 'ad' };
    let details = {};
    try { details = (player.getPlayerResponse && player.getPlayerResponse().videoDetails) || {}; } catch {}
    return {
      ok: true,
      videoId,
      t: Math.round(player.getCurrentTime() * 10) / 10,
      duration: player.getDuration ? player.getDuration() : null,
      title: details.title || data.title || document.title.replace(/ - YouTube$/, ''),
      channel: details.author || data.author || '',
      description: (details.shortDescription || '').slice(0, 3000),
      isLive: !!(details.isLive || data.isLive),
    };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__earmark !== 'request') return;
    const { id, kind } = ev.data;
    const reply = (payload) => window.postMessage({ __earmark: 'reply', id, payload }, location.origin);
    try {
      if (kind === 'snapshot') {
        reply(snapshot());
      } else if (kind === 'transcript') {
        const transcript = await getTranscript(ev.data.videoId);
        // "none": the video has no captions. "failed": it has, but they could not be read just now.
        reply({ ok: true, transcript, reason: transcript ? null : noCaptions.has(ev.data.videoId) ? 'none' : 'failed' });
      }
    } catch (e) {
      reply({ ok: false, reason: String(e && e.message || e) });
    }
  });
})();
