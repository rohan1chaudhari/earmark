import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterBookmarks, isFiltered, localDayBounds, facets, collectVocabulary, groupByVideo, playbackPosition, searchText, NO_FILTERS,
} from '../lib/library.js';

const bm = (id, over = {}) => ({
  id, media_id: 'vid1', title: 'Rick Rubin on Work', channel: 'David Senra', t_press: 100, width: 'normal',
  pressed_at: '2026-11-10T12:00:00.000Z', status: 'ok', transcript_span: 'plain words here',
  span: { start: 80, end: 98 },
  note: { title: 'Taste comes first', idea: 'An idea.', speaker: '', category: 'creativity', tags: ['taste', 'work-ethic'], quote: 'Taste comes first' },
  ...over,
});

const library = [
  bm('a'),
  bm('b', { media_id: 'vid2', title: 'Founders 300', channel: 'Founders', pressed_at: '2026-11-12T08:00:00.000Z', span: { start: 500, end: 530 },
    note: { title: 'Über focus', idea: 'Say no.', speaker: 'Steve', category: 'startups', tags: ['focus'], quote: '' } }),
  // Made before tags existed: no category, tags or quote.
  bm('c', { pressed_at: '2026-11-14T08:00:00.000Z', span: { start: 20, end: 40 }, transcript_span: 'old transcript about practice', note: { title: 'Old one', idea: 'Old idea.', speaker: '' } }),
  // Still queued: no note or span yet.
  bm('d', { status: 'queued', pressed_at: '2026-11-15T08:00:00.000Z', t_press: 300, note: undefined, span: undefined, transcript_span: undefined }),
];
const ids = (list) => list.map((b) => b.id);

test('no filters returns everything in the given order', () => {
  assert.deepEqual(ids(filterBookmarks(library, {})), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterBookmarks(library, NO_FILTERS)), ['a', 'b', 'c', 'd']);
  assert.equal(isFiltered(NO_FILTERS), false);
  assert.equal(isFiltered({ q: '   ' }), false);
  assert.equal(isFiltered({ tag: 'taste' }), true);
});

test('search matches every field, ignoring case and accents, all words required', () => {
  assert.deepEqual(ids(filterBookmarks(library, { q: 'TASTE' })), ['a']);
  assert.deepEqual(ids(filterBookmarks(library, { q: 'uber' })), ['b']);
  assert.deepEqual(ids(filterBookmarks(library, { q: 'work ethic' })), ['a']);
  assert.deepEqual(ids(filterBookmarks(library, { q: 'practice' })), ['c']);
  assert.deepEqual(ids(filterBookmarks(library, { q: 'senra' })), ['a', 'c', 'd']);
  assert.deepEqual(ids(filterBookmarks(library, { q: 'founders steve' })), ['b']);
  assert.deepEqual(ids(filterBookmarks(library, { q: 'founders taste' })), []);
  assert.ok(searchText(library[3]).includes('rick rubin'));
});

test('exact filters handle bookmarks with no tags or category', () => {
  assert.deepEqual(ids(filterBookmarks(library, { tag: 'taste' })), ['a']);
  assert.deepEqual(ids(filterBookmarks(library, { category: 'startups' })), ['b']);
  assert.deepEqual(ids(filterBookmarks(library, { channel: 'David Senra' })), ['a', 'c', 'd']);
  assert.deepEqual(ids(filterBookmarks(library, { video: 'vid1', q: 'old' })), ['c']);
});

test('date range is inclusive of whole local days', () => {
  const { since, until } = localDayBounds('2026-11-12', '2026-11-14');
  assert.equal(since, new Date(2026, 10, 12).toISOString());
  assert.equal(until, new Date(2026, 10, 15).toISOString());
  assert.deepEqual(localDayBounds('', 'nonsense'), { since: '', until: '' });
  const at = (iso) => ({ ...library[0], id: iso, pressed_at: iso });
  const start = new Date(2026, 10, 12), end = new Date(2026, 10, 15);
  const inside = [new Date(start), new Date(end - 1)].map((d) => at(d.toISOString()));
  const outside = [new Date(start - 1), new Date(end)].map((d) => at(d.toISOString()));
  assert.deepEqual(ids(filterBookmarks([...outside, ...inside], { since, until })), ids(inside));
  assert.deepEqual(ids(filterBookmarks(library, localDayBounds('2026-11-13', ''))).length, 2);
});

test('facets count values, most used first, skipping missing ones', () => {
  const f = facets(library);
  assert.deepEqual(f.categories.map((e) => [e.value, e.count]), [['creativity', 1], ['startups', 1]]);
  assert.deepEqual(f.tags.map((e) => e.value), ['focus', 'taste', 'work-ethic']);
  assert.deepEqual(f.channels.map((e) => [e.value, e.count]), [['David Senra', 3], ['Founders', 1]]);
  assert.deepEqual(f.videos.map((e) => [e.value, e.label, e.count]), [['vid1', 'Rick Rubin on Work', 3], ['vid2', 'Founders 300', 1]]);
});

test('vocabulary lists categories and tags in use, capped', () => {
  const many = Array.from({ length: 5 }, (_, i) => bm(`m${i}`, { note: { category: 'Creativity', tags: [`t${i}`, 'taste'] } }));
  const vocab = collectVocabulary([...library, ...many], { categories: 5, tags: 3 });
  assert.deepEqual(vocab.categories, ['creativity', 'startups']);
  assert.deepEqual(vocab.tags, ['taste', 'focus', 't0']);
  assert.deepEqual(collectVocabulary([]), { categories: [], tags: [] });
});

test('grouping by video: newest video first, bookmarks in playback order', () => {
  const groups = groupByVideo(library);
  assert.deepEqual(groups.map((g) => g.media_id), ['vid1', 'vid2']);
  assert.deepEqual(ids(groups[0].items), ['c', 'a', 'd']);
  assert.equal(groups[0].title, 'Rick Rubin on Work');
  assert.equal(groups[0].channel, 'David Senra');
  assert.equal(groups[0].items.length, 3);
  assert.equal(playbackPosition(library[3]), 300);
  assert.equal(playbackPosition(library[0]), 80);
});

test('transcriptParagraphs marks the passage and places the press', async () => {
  const { transcriptParagraphs } = await import('../lib/library.js');
  const segs = [0, 10, 20, 30, 40, 50, 60].map((s) => ({ s, d: 10, text: `t${s}` }));
  const paras = transcriptParagraphs(segs, { start: 20, end: 50, t_press: 45 });
  assert.deepEqual(paras.map((p) => p.s), [0, 30, 60]);
  assert.deepEqual(paras[0].parts, [{ text: 't0 t10', marked: false }, { text: 't20', marked: true }]);
  assert.deepEqual(paras[1].parts, [{ text: 't30 t40', marked: true }, { press: true }, { text: 't50', marked: false }]);
  const late = transcriptParagraphs(segs, { start: 20, end: 50, t_press: 999 });
  assert.deepEqual(late.at(-1).parts.at(-1), { press: true });
});

test('transcriptParagraphs breaks at speaker turns and cleanTurns tidies them', async () => {
  const { transcriptParagraphs } = await import('../lib/library.js');
  const { cleanTurns } = await import('../lib/pipeline.js');
  const segs = [0, 10, 20, 30, 40, 50, 60].map((s) => ({ s, d: 10, text: `t${s}` }));
  const turns = cleanTurns({ turns: [{ t: 41, speaker: ' Rick  Rubin ' }, { t: 1, speaker: 'Host' }, { t: 11, speaker: 'Host' }, { t: 'x', speaker: 'Bad' }] }, segs);
  assert.deepEqual(turns, [{ t: 0, speaker: 'Host' }, { t: 40, speaker: 'Rick Rubin' }]);
  const paras = transcriptParagraphs(segs, { start: 20, end: 50, t_press: 45, turns });
  assert.deepEqual(paras.map((p) => [p.s, p.speaker]), [[0, 'Host'], [30, undefined], [40, 'Rick Rubin']]);
  assert.deepEqual(cleanTurns({ turns: 'no' }, segs), []);
});
