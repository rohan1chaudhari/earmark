import { fmtTime, playUrl, clipUrl, renderNote, noteFilename } from './lib/pipeline.js';
import { filterBookmarks, groupByVideo, facets, isFiltered, localDayBounds, transcriptParagraphs } from './lib/library.js';

const $ = (id) => document.getElementById(id);
const list = $('list');
const count = $('count');
const clear = $('clear');
const filtersBox = $('filters');
const toggleFilters = $('toggleFilters');
let filtersOpen = false;
const controls = {
  q: $('q'), category: $('category'), tag: $('tag'), channel: $('channel'), video: $('video'), from: $('from'), to: $('to'),
};
const viewButtons = [...document.querySelectorAll('[data-view]')];

let bookmarks = [];
let view = 'latest';
try { if (localStorage.getItem('earmark:view') === 'videos') view = 'videos'; } catch {}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const send = (msg) => chrome.runtime.sendMessage(msg);
const act = (bm, type, extra = {}) => async () => { await send({ type, id: bm.id, ...extra }); render(); };
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const videoUrl = (bm, at) => `https://www.youtube.com/watch?v=${bm.media_id}${at != null ? `&t=${at}s` : ''}`;

function statusTag(bm) {
  if (bm.status === 'queued') return el('span', { class: 'tag warn' }, 'queued');
  if (bm.status === 'processing') return el('span', { class: 'tag busy' }, el('span', { class: 'spinner' }), bm.stage === 'rewrite' ? 'Writing the note…' : 'Finding the passage…');
  if (bm.status === 'no-transcript') return el('span', { class: 'tag warn' }, 'no captions');
  if (bm.status === 'waiting-transcript') return el('span', { class: 'tag warn' }, 'waiting for captions');
  if (bm.status === 'error') return el('span', { class: 'tag bad' }, 'failed');
  if (bm.span?.needs_review) return el('span', { class: 'tag warn', title: 'The model was not sure this is the passage you meant' }, 'unsure');
  return null;
}

// --- Clip playback -------------------------------------------------------
// The iframe is created only on click. Embeds may refuse to play inside an
// extension page, so the source line always links straight to YouTube too.

function toggleClip(node, bm) {
  const slot = node.querySelector('.player');
  if (slot.firstChild) return closeClip(node);
  slot.replaceChildren(el('iframe', {
    src: clipUrl(bm, { autoplay: true }),
    title: `Clip: ${bm.note.title}`,
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowfullscreen: '',
    // YouTube refuses some embeds that arrive with no referrer at all.
    referrerpolicy: 'strict-origin-when-cross-origin',
  }));
  slot.hidden = false;
  const b = node.querySelector('.play-clip');
  if (b) b.textContent = 'Close clip';
}

function closeClip(node) {
  const slot = node.querySelector?.('.player');
  if (!slot || !slot.firstChild) return;
  slot.replaceChildren();
  slot.hidden = true;
  const b = node.querySelector('.play-clip');
  if (b) b.textContent = 'Play';
}

function flash(button, text) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = old; }, 1500);
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Could not copy');
  }
}

// The Markdown note is built from the bookmark on demand, so it is always
// there to come back to and never has to be saved as a file first.
const savedDetails = async (bm) => (await chrome.storage.local.get(`dt:${bm.id}`))[`dt:${bm.id}`] || null;

async function downloadNote(bm) {
  const url = URL.createObjectURL(new Blob([renderNote(bm, await savedDetails(bm))], { type: 'text/markdown' }));
  const a = el('a', { href: url, download: bm.file || noteFilename(bm) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The whole video's transcript, opened at the passage: the passage is
// highlighted and a marker sits where the button was pressed. Speaker names
// are worked out by the model the first time a video's transcript is opened.
function fullTranscript(bm) {
  const status = el('p', { class: 'meta transcript-status' });
  const box = el('div', { class: 'transcript', tabindex: '0', role: 'region', 'aria-label': 'Transcript of the whole video' });
  const wrap = el('div', {}, status, box);
  const key = `tr:${bm.media_id}`;
  const passageOnly = () => {
    status.textContent = 'The full transcript is no longer saved for this video. This is the bookmarked passage.';
    box.replaceChildren(el('p', {}, el('mark', {}, bm.transcript_span)));
  };
  const draw = (segments, turns) => {
    // Keep the reader's place when speaker names arrive; open at the passage otherwise.
    const had = box.querySelector('mark');
    const offset = had ? had.getBoundingClientRect().top - box.getBoundingClientRect().top : 56;
    const paras = transcriptParagraphs(segments, { start: bm.span.start, end: bm.span.end, t_press: bm.t_press, turns });
    box.replaceChildren(...paras.map((para) => el('p', { class: para.speaker ? 'turn' : null },
      el('a', { class: 'ts', href: videoUrl(bm, Math.floor(para.s)), target: '_blank', rel: 'noopener' }, fmtTime(para.s)),
      para.speaker ? el('b', { class: 'who' }, para.speaker) : null,
      para.parts.map((part) => part.press
        ? el('span', { class: 'press', title: 'Where you pressed' }, `Pressed ${fmtTime(bm.t_press)}`)
        : [part.marked ? el('mark', {}, part.text) : part.text, ' ']))));
    const first = box.querySelector('mark');
    if (first) box.scrollTop += first.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
  };
  const guessed = 'Speakers are worked out from the wording, not from voices, so some turns may be wrong.';
  chrome.storage.local.get(key).then(async (got) => {
    const tr = got[key];
    if (!tr?.segments?.length) return passageOnly();
    draw(tr.segments, tr.turns);
    if (tr.turns?.length) { status.textContent = guessed; return; }
    status.replaceChildren(el('span', { class: 'spinner' }), ' Working out who is speaking…');
    const res = await send({ type: 'earmark:speakers', media_id: bm.media_id });
    if (res?.ok) { draw(tr.segments, res.turns); status.textContent = guessed; }
    else status.textContent = `Could not label the speakers. ${res?.error || ''}`.trim();
  }).catch(passageOnly);
  return wrap;
}

// Detailed notes: class notes on the passage, still in points. Written by the
// model the first time they are opened, then kept with the bookmark.
function detailedNotes(bm) {
  const box = el('div', { class: 'details' });
  // replaceChildren does not flatten arrays, so flatten here and drop empties.
  const show = (d) => box.replaceChildren(...[
    d.takeaway ? el('p', { class: 'remember' }, el('b', {}, 'Remember'), d.takeaway) : null,
    d.sections.map((s) => el('section', {},
      el('h5', {}, s.heading),
      el('ul', {}, s.points.map((pt) => el('li', {}, pt.text, pt.sub.length ? el('ul', {}, pt.sub.map((x) => el('li', {}, x))) : null))))),
    d.terms.length ? el('section', {}, el('h5', {}, 'Terms'),
      el('dl', { class: 'terms' }, d.terms.map((x) => [el('dt', {}, x.term), el('dd', {}, x.meaning)]))) : null,
  ].flat(Infinity).filter(Boolean));
  const ask = async () => {
    box.replaceChildren(el('p', { class: 'meta transcript-status' }, el('span', { class: 'spinner' }), ' Writing detailed notes… about 15 seconds.'));
    const res = await send({ type: 'earmark:details', id: bm.id });
    if (res?.ok) return show(res.details);
    const again = el('button', { class: 'link', onclick: ask }, 'Try again');
    box.replaceChildren(el('p', { class: 'meta' }, `Could not write detailed notes. ${res?.error || ''} `, again));
  };
  savedDetails(bm).then((d) => (d?.sections?.length ? show(d) : ask()));
  return box;
}

// --- A note: its title, then its points. Everything else is one click away.

function note(bm, { underVideo = false } = {}) {
  const n = bm.note;
  const points = Array.isArray(n.points) ? n.points : [];
  const tags = Array.isArray(n.tags) ? n.tags : [];
  let node;

  // Sections that open under the note. Built on first use: most never open.
  const drawer = el('div', { class: 'drawer' });
  drawer.hidden = true;
  let showing = null;
  const sections = {
    more: () => {
      const copyClip = el('button', { onclick: () => copyText(copyClip, clipUrl(bm)) }, 'Copy clip link');
      const copyNote = el('button', { onclick: async () => copyText(copyNote, renderNote(bm, await savedDetails(bm))) }, 'Copy as Markdown');
      return el('div', { class: 'more' },
        // Notes with points keep their one-line summary here; older notes show it in place of points.
        points.length && n.idea ? el('p', { class: 'gist' }, n.idea) : null,
        n.quote ? el('blockquote', { class: 'quote' }, `“${n.quote}”`) : null,
        n.category || tags.length ? el('p', { class: 'tags' },
          n.category ? el('button', { class: 'link', onclick: () => setFilter('category', n.category) }, n.category) : null,
          tags.map((t) => el('button', { class: 'link', onclick: () => setFilter('tag', t) }, `#${t}`))) : null,
        el('div', { class: 'row' }, copyNote, el('button', { onclick: () => downloadNote(bm) }, 'Download .md'), copyClip),
        el('div', { class: 'row' },
          el('span', { class: 'meta' }, 'Right passage?'),
          el('button', { onclick: act(bm, 'earmark:correct', { kind: 'right' }) }, bm.verdict === 'right' ? '✓ Yes' : 'Yes'),
          el('button', { onclick: act(bm, 'earmark:correct', { kind: 'wider' }) }, 'Wider'),
          el('button', { onclick: act(bm, 'earmark:correct', { kind: 'narrower' }) }, 'Narrower'),
          el('button', { onclick: act(bm, 'earmark:correct', { kind: 'wrong' }) }, 'Wrong'),
          el('span', { class: 'spacer' }),
          el('button', { class: 'danger', onclick: act(bm, 'earmark:delete') }, 'Delete'),
        ),
      );
    },
    transcript: () => fullTranscript(bm),
    details: () => detailedNotes(bm),
  };
  const links = {};
  const open = (name) => {
    showing = showing === name ? null : name;
    drawer.hidden = !showing;
    if (showing) drawer.replaceChildren(sections[showing]());
    for (const [k, b] of Object.entries(links)) b.setAttribute('aria-expanded', String(k === showing));
  };
  const link = (name, label) => (links[name] = el('button', { class: 'link', 'aria-expanded': 'false', onclick: () => open(name) }, label));

  const player = el('div', { class: 'player' });
  player.hidden = true;
  const time = `${fmtTime(bm.span.start)}–${fmtTime(bm.span.end)}`;

  node = el('article', { class: 'note' },
    el('h2', {}, n.title, statusTag(bm)),
    points.length
      ? el('ul', { class: 'points' }, points.map((p) => el('li', {}, p.label ? el('strong', {}, p.label) : null, p.label ? ' ' : '', p.text)))
      : el('p', { class: 'idea' }, n.idea),
    player,
    el('p', { class: 'foot' },
      el('a', { class: 'src', href: playUrl(bm), target: '_blank', rel: 'noopener', title: 'Open this passage on YouTube' },
        underVideo ? null : el('span', { class: 'name' }, bm.title || bm.media_id),
        el('span', { class: 'at' }, time)),
      el('span', { class: 'acts' },
        el('button', { class: 'link play-clip', onclick: () => toggleClip(node, bm) }, 'Play'),
        link('details', 'Details'),
        link('transcript', 'Transcript'),
        link('more', 'More'),
      ),
    ),
    drawer,
  );
  return node;
}

// A press that has no note (yet): working, waiting, or failed.
function pending(bm) {
  const url = videoUrl(bm, Math.max(0, Math.floor(bm.t_press - 30)));
  return el('article', { class: 'note pending' },
    el('h2', {}, `Pressed at ${fmtTime(bm.t_press)}`, statusTag(bm)),
    bm.status === 'processing' ? el('div', { class: 'progress' }, el('span', {})) : null,
    bm.message ? el('p', { class: 'idea' }, bm.message) : null,
    el('p', { class: 'foot' },
      el('a', { class: 'src', href: url, target: '_blank', rel: 'noopener' }, bm.title || bm.media_id),
      el('span', { class: 'acts shown' },
        bm.status === 'error' || bm.status === 'queued' ? el('button', { class: 'link', onclick: act(bm, 'earmark:retry') }, 'Try again') : null,
        el('button', { class: 'link', onclick: act(bm, 'earmark:delete') }, 'Delete'),
      ),
    ),
  );
}

function groupHeader(g) {
  return el('div', { class: 'group' },
    el('h3', {}, el('a', { href: videoUrl(g), target: '_blank', rel: 'noopener' }, g.title || g.media_id)),
    g.channel ? el('p', { class: 'meta' }, g.channel) : null,
  );
}

// Nodes are reused while their data is unchanged, so a storage change does
// not close a playing clip, collapse an open section, or lose focus.
const cache = new Map();
function cached(key, sig, build) {
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.node;
  const node = build();
  cache.set(key, { sig, node });
  return node;
}

// Put exactly these nodes in #list, moving as few as possible: moving an
// iframe reloads it, unless the browser has moveBefore, which keeps its state.
function place(nodes) {
  const keep = new Set(nodes);
  for (const child of [...list.children]) {
    if (!keep.has(child)) { closeClip(child); child.remove(); }
  }
  let ref = list.firstChild;
  for (const node of nodes) {
    if (node === ref) { ref = ref.nextSibling; continue; }
    if (node.parentNode === list && typeof list.moveBefore === 'function') list.moveBefore(node, ref);
    else list.insertBefore(node, ref);
  }
  for (const [key, { node }] of cache) if (!keep.has(node)) cache.delete(key);
}

// --- Filters -------------------------------------------------------------

function currentFilters() {
  return {
    q: controls.q.value,
    ...localDayBounds(controls.from.value, controls.to.value),
    channel: controls.channel.value,
    category: controls.category.value,
    tag: controls.tag.value,
    video: controls.video.value,
  };
}

// Rebuilding a <select> while it is open closes it, so only rebuild when the
// options really changed, and keep the chosen value even if it has gone.
function fillSelect(select, options, allLabel) {
  const value = select.value;
  const sig = JSON.stringify(options);
  if (select.dataset.sig === sig) return;
  select.dataset.sig = sig;
  const opts = [el('option', { value: '' }, allLabel), ...options.map((o) => el('option', { value: o.value }, `${o.label} (${o.count})`))];
  if (value && !options.some((o) => o.value === value)) opts.push(el('option', { value }, `${value} (0)`));
  select.replaceChildren(...opts);
  select.value = value;
}

function setFilter(name, value) {
  const select = controls[name];
  if (![...select.options].some((o) => o.value === value)) select.append(el('option', { value }, value));
  select.value = value;
  draw();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateFacets() {
  const f = facets(bookmarks);
  fillSelect(controls.category, f.categories, 'All categories');
  fillSelect(controls.tag, f.tags, 'All tags');
  fillSelect(controls.channel, f.channels, 'All channels');
  fillSelect(controls.video, f.videos, 'All videos');
}

// --- Rendering -----------------------------------------------------------

const item = (bm, underVideo) => cached(`${underVideo ? 'v' : 'l'}:${bm.id}`, JSON.stringify(bm),
  () => (bm.status === 'ok' ? note(bm, { underVideo }) : pending(bm)));

function draw() {
  const filters = currentFilters();
  const shown = filterBookmarks(bookmarks, filters);
  const filtered = isFiltered(filters);
  count.textContent = filtered ? `${shown.length} of ${bookmarks.length}` : '';
  clear.hidden = !filtered;
  // The filter row stays out of the way until it is asked for or in use.
  const picked = ['category', 'tag', 'channel', 'video', 'from', 'to'].filter((n) => controls[n].value).length;
  filtersBox.hidden = !(filtersOpen || picked);
  $('filterCount').textContent = picked || '';
  toggleFilters.setAttribute('aria-expanded', String(!filtersBox.hidden));
  for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === view));

  let nodes;
  if (!bookmarks.length) {
    nodes = [cached('empty', '', () => el('div', { class: 'empty' }, 'Nothing saved yet. On a YouTube video, press ', el('kbd', {}, navigator.platform.startsWith('Mac') ? '⌥ B' : 'Alt + B'), ' when something is worth keeping.'))];
  } else if (!shown.length) {
    nodes = [cached('none', '', () => el('div', { class: 'empty' }, 'Nothing matches.'))];
  } else if (view === 'videos') {
    nodes = groupByVideo(shown).flatMap((g) => [
      cached(`group:${g.media_id}`, JSON.stringify([g.title, g.channel]), () => groupHeader(g)),
      ...g.items.map((bm) => item(bm, true)),
    ]);
  } else {
    nodes = shown.map((bm) => item(bm, false));
  }
  place(nodes);
}

function clearFilters() {
  for (const c of Object.values(controls)) c.value = '';
  filtersOpen = false;
  draw();
}

let generation = 0;
async function render() {
  // Storage can change several times in quick succession; only draw the latest answer.
  const mine = ++generation;
  const res = await send({ type: 'earmark:list' });
  if (mine !== generation || !res) return;
  bookmarks = res.bookmarks;
  updateFacets();
  draw();
}

controls.q.addEventListener('input', draw);
for (const name of ['category', 'tag', 'channel', 'video', 'from', 'to']) controls[name].addEventListener('change', draw);
clear.addEventListener('click', clearFilters);
toggleFilters.addEventListener('click', () => { filtersOpen = filtersBox.hidden; draw(); });
for (const b of viewButtons) {
  b.addEventListener('click', () => {
    view = b.dataset.view;
    try { localStorage.setItem('earmark:view', view); } catch {}
    draw();
  });
}

render();
chrome.storage.onChanged.addListener(render);
