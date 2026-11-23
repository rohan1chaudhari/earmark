// Logic over the whole bookmark collection: search, filters, grouping, the
// tag vocabulary. Pure, so it is unit-tested in Node; bookmarks.js only does
// the DOM work. Bookmarks made before tags existed have no category, tags or
// quote, and bookmarks still in the queue have no note at all.
import { foldText, kebab } from './pipeline.js';

export const NO_FILTERS = Object.freeze({ q: '', since: '', until: '', channel: '', category: '', tag: '', video: '' });

const tagsOf = (bm) => (Array.isArray(bm.note?.tags) ? bm.note.tags : []);
const categoryOf = (bm) => bm.note?.category || '';

// Diacritics are dropped as well, so "uber" finds "Über".
export function searchFold(text) {
  return foldText(text).normalize('NFD').replace(/\p{M}/gu, '');
}

export function searchText(bm) {
  const n = bm.note || {};
  return searchFold(
    [n.title, n.idea, ...(Array.isArray(n.points) ? n.points.flatMap((p) => [p.label, p.text]) : []), n.quote, n.speaker, bm.transcript_span, bm.title, bm.channel, n.category, ...tagsOf(bm)]
      .filter(Boolean)
      .join('\n'),
  );
}

// Every search word must appear somewhere; the other filters are exact.
// since/until are ISO instants compared with pressed_at (see localDayBounds).
export function filterBookmarks(bookmarks, filters = {}) {
  const f = { ...NO_FILTERS, ...filters };
  const terms = searchFold(f.q).split(' ').filter(Boolean);
  return bookmarks.filter((bm) => {
    const at = bm.pressed_at || '';
    if (f.since && at < f.since) return false;
    if (f.until && at >= f.until) return false;
    if (f.channel && bm.channel !== f.channel) return false;
    if (f.video && bm.media_id !== f.video) return false;
    if (f.category && categoryOf(bm) !== f.category) return false;
    if (f.tag && !tagsOf(bm).includes(f.tag)) return false;
    if (terms.length) {
      const text = searchText(bm);
      if (!terms.every((t) => text.includes(t))) return false;
    }
    return true;
  });
}

export function isFiltered(filters = {}) {
  return Object.keys(NO_FILTERS).some((k) => String(filters[k] ?? '').trim() !== '');
}

// Date inputs give local calendar days; turn an inclusive from/to pair into
// the instants that bound them. Either side may be empty.
export function localDayBounds(from, to) {
  const day = (s, offset) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3] + offset).toISOString() : '';
  };
  return { since: day(from, 0), until: day(to, 1) };
}

// Values for each filter with how many bookmarks have them, most used first.
export function facets(bookmarks) {
  const tally = (pairs) => {
    const seen = new Map();
    for (const [value, label] of pairs) {
      if (!value) continue;
      const entry = seen.get(value) || { value, label: label || value, count: 0 };
      entry.count++;
      seen.set(value, entry);
    }
    return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  return {
    categories: tally(bookmarks.map((b) => [categoryOf(b)])),
    tags: tally(bookmarks.flatMap((b) => [...new Set(tagsOf(b))].map((t) => [t]))),
    channels: tally(bookmarks.map((b) => [b.channel])),
    videos: tally(bookmarks.map((b) => [b.media_id, b.title])),
  };
}

// Categories and tags already in use, passed to the rewrite task so the model
// reuses them instead of inventing near-duplicates. Capped to keep the prompt short.
export function collectVocabulary(bookmarks, { categories = 30, tags = 80 } = {}) {
  const { categories: cats, tags: tgs } = facets(bookmarks);
  const clean = (list, cap) => [...new Set(list.map((e) => kebab(e.value)).filter(Boolean))].slice(0, cap);
  return { categories: clean(cats, categories), tags: clean(tgs, tags) };
}

// Where in the video a bookmark sits: the passage if one was found, else the press.
export function playbackPosition(bm) {
  return Number.isFinite(bm.span?.start) ? bm.span.start : Number(bm.t_press) || 0;
}

// One group per video, the most recently bookmarked video first, each video's
// bookmarks in playback order.
export function groupByVideo(bookmarks) {
  const groups = new Map();
  for (const bm of bookmarks) {
    let g = groups.get(bm.media_id);
    if (!g) groups.set(bm.media_id, (g = { media_id: bm.media_id, title: '', channel: '', latest: '', items: [] }));
    g.items.push(bm);
    const at = bm.pressed_at || '';
    // Take the title from the newest press, in case the video was renamed.
    if (at >= g.latest) {
      g.latest = at;
      g.title = bm.title || g.title;
      g.channel = bm.channel || g.channel;
    } else {
      g.title ||= bm.title || '';
      g.channel ||= bm.channel || '';
    }
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => playbackPosition(a) - playbackPosition(b) || (a.t_press || 0) - (b.t_press || 0));
  }
  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

// The whole transcript as paragraphs for reading, with the chosen passage
// marked and the press placed where it happened. A paragraph is `every`
// seconds of speech, or shorter when the speaker changes; the first paragraph
// of each turn carries `speaker`. Parts are { text, marked } runs or { press: true }.
export function transcriptParagraphs(segments, { start, end, t_press, turns } = {}, every = 30) {
  const paras = [];
  let para = null;
  let pressed = !Number.isFinite(t_press);
  let next = 0;
  const changes = Array.isArray(turns) ? turns : [];
  const push = (part) => {
    const last = para.parts[para.parts.length - 1];
    if (!part.press && last && !last.press && last.marked === part.marked) last.text += ` ${part.text}`;
    else para.parts.push(part);
  };
  for (const seg of segments || []) {
    const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let speaker = null;
    while (next < changes.length && changes[next].t <= seg.s + 0.05) speaker = changes[next++].speaker;
    if (!para || speaker || seg.s - para.s >= every) {
      paras.push(para = { s: seg.s, parts: [] });
      if (speaker) para.speaker = speaker;
    }
    if (!pressed && seg.s > t_press) { push({ press: true }); pressed = true; }
    push({ text, marked: seg.s >= start - 0.05 && seg.s < end - 0.05 });
  }
  if (!pressed && para) para.parts.push({ press: true });
  return paras;
}
