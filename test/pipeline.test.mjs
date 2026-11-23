import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSpan, spanText, segEnd, renderNote, noteFilename, transcriptBlock, spanTask, fmtTime,
  REWRITE_SCHEMA, SPAN_SCHEMA, rewriteTask, kebab, normaliseTags, verifyQuote, cleanNote, playUrl, clipUrl,
} from '../lib/pipeline.js';

// Overlapping durations, like auto-captions.
const segs = Array.from({ length: 100 }, (_, i) => ({ s: i * 3, d: 5, text: `line${i}` }));
const press = { t_press: 150, width: 'normal' };

test('segment ends at the next start when captions overlap', () => {
  assert.equal(segEnd(segs, 0), 3);
  assert.equal(segEnd(segs, 99), 302);
});

test('valid span snaps outward to caption boundaries', () => {
  const r = resolveSpan({ start: 100.4, end: 145.2, confidence: 'high', why: 'x' }, segs, press);
  assert.equal(r.start, 99);
  assert.equal(r.end, 147);
  assert.equal(r.needs_review, false);
  assert.equal(r.source, 'model');
});

test('low confidence keeps the model\'s own choice and flags it', () => {
  const r = resolveSpan({ start: 120, end: 144, confidence: 'low', why: '' }, segs, press);
  assert.equal(r.start, 120);
  assert.equal(r.end, 144);
  assert.equal(r.needs_review, true);
  assert.equal(r.source, 'model');
});

test('the model decides the length: long and far-back passages are kept', () => {
  const long = resolveSpan({ start: 3, end: 149, confidence: 'high', why: '' }, segs, press);
  assert.equal(long.start, 3);
  assert.equal(long.end, 150);
  assert.equal(long.source, 'model');
  const early = resolveSpan({ start: 6, end: 12, confidence: 'high', why: '' }, segs, press);
  assert.equal(early.start, 6);
  assert.equal(early.end, 12);
  assert.equal(early.source, 'model');
  const after = resolveSpan({ start: 141, end: 171, confidence: 'high', why: '' }, segs, press);
  assert.equal(after.end, 171);
});

test('an unusable answer falls back to a fixed window', () => {
  for (const raw of [{ start: 500, end: 560 }, { start: 140, end: 100 }, { start: NaN, end: 3 }, null, { start: -5, end: 20 }]) {
    const r = resolveSpan(raw, segs, press);
    assert.equal(r.source, 'fallback');
    assert.equal(r.start, 90);
    assert.equal(r.end, 156);
    assert.equal(r.needs_review, true);
  }
});

test('span text covers exactly the chosen segments', () => {
  assert.equal(spanText(segs, 99, 108), 'line33 line34 line35');
});

test('prompt keeps the press out of the cached transcript block', () => {
  const block = transcriptBlock({ title: 'T', channel: 'C', description: 'D' }, segs);
  assert.ok(!block.includes('150'.concat('.0 seconds')));
  assert.ok(block.includes('[297.0] line99'));
  assert.ok(spanTask(press).includes('t=150.0 seconds (2:30)'));
  assert.ok(spanTask({ ...press, width: 'wide' }).includes('whole argument'));
  assert.ok(!/\b(15|120) (to|seconds)|5 minutes/.test(spanTask(press)));
  assert.ok(spanTask(press).includes('no target length'));
  assert.ok(spanTask(press, { kind: 'wider', start: 99, end: 147 }).includes('too narrow'));
});

test('note renders with link, times, and transcript', () => {
  const bm = {
    id: '2026-11-18T09-14-07-123Z-abcd', source: 'youtube', media_id: 'abcd1234567', title: 'A "quoted" title', channel: 'Chan',
    t_press: 150, width: 'normal', pressed_at: '2026-11-18T09:14:07.123Z', captions: 'auto',
    span: { start: 99, end: 147, confidence: 'high', needs_review: false },
    note: { title: 'Ideas Compound: Über Zeit!', idea: 'An idea.', speaker: 'Ada' },
    transcript_span: 'line33 line34',
  };
  const md = renderNote(bm);
  assert.ok(md.includes('url: https://www.youtube.com/watch?v=abcd1234567&t=97s'));
  assert.ok(md.includes('title: "A \\"quoted\\" title"'));
  assert.ok(md.includes('[▶ 1:39–2:27]'));
  assert.ok(md.includes('> line33 line34'));
  assert.equal(noteFilename(bm), '2026-11-18-ideas-compound-uber-zeit-09-14-07.md');
  assert.equal(fmtTime(3725), '1:02:05');
});

// OpenAI strict structured output (Codex) rejects schemas that leave a
// property optional, allow extra properties, or use length/count keywords.
function assertStrict(schema, path = 'schema') {
  const banned = ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format'];
  for (const k of banned) assert.ok(!(k in schema), `${path} uses ${k}`);
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} allows extra properties`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} leaves a property optional`);
    for (const [k, v] of Object.entries(schema.properties)) assertStrict(v, `${path}.${k}`);
  }
  if (schema.type === 'array') assertStrict(schema.items, `${path}[]`);
}

test('both schemas satisfy strict structured output', () => {
  assertStrict(SPAN_SCHEMA);
  assertStrict(REWRITE_SCHEMA);
  for (const k of ['category', 'tags', 'quote']) assert.ok(REWRITE_SCHEMA.required.includes(k));
});

test('vocabulary goes in the rewrite task, never in the cached block', () => {
  const meta = { title: 'T', channel: 'C', description: 'D' };
  const before = transcriptBlock(meta, segs);
  const task = rewriteTask({ start: 99, end: 147 }, { categories: ['creativity'], tags: ['deliberate-practice', 'taste'] });
  assert.equal(transcriptBlock(meta, segs), before);
  assert.ok(!before.includes('deliberate-practice'));
  assert.ok(task.includes('Categories already in use: creativity.'));
  assert.ok(task.includes('Tags already in use: deliberate-practice, taste.'));
  assert.ok(task.startsWith('Task: turn one passage into a note'));
  const empty = rewriteTask({ start: 99, end: 147 });
  assert.ok(empty.includes('No categories are in use yet.') && empty.includes('No tags are in use yet.'));
});

test('tags are lowercase kebab-case, deduplicated, at most four', () => {
  assert.equal(kebab('  Deliberate Practice! '), 'deliberate-practice');
  assert.equal(kebab('#Start_ups'), 'start-ups');
  assert.equal(kebab('Über Zeit'), 'über-zeit');
  assert.equal(kebab('创造力'), '创造力');
  assert.equal(kebab('a'.repeat(39) + ' b'), 'a'.repeat(39));
  assert.deepEqual(normaliseTags(['Taste', 'taste', ' TASTE ', 'Work Ethic', '', '---', 'a', 'b', 'c']), ['taste', 'work-ethic', 'a', 'b']);
  assert.deepEqual(normaliseTags('one, Two'), ['one', 'two']);
  assert.deepEqual(normaliseTags(undefined), []);
  assert.deepEqual(normaliseTags([null, 3]), ['3']);
});

const passage = 'and he said I don’t think you can be great — at anything you don’t love so he kept going';

test('a verbatim quote passes after folding case, spacing, quotes, and dashes', () => {
  assert.equal(verifyQuote("I don't think you can be great - at anything", passage), "I don't think you can be great - at anything");
  assert.equal(verifyQuote('“i DON’T think  you can\nbe great — at anything you don’t love.”', passage),
    'i DON’T think you can be great — at anything you don’t love');
});

test('a paraphrase or partial word is rejected as a quote', () => {
  assert.equal(verifyQuote('You cannot be great at anything you do not love.', passage), '');
  assert.equal(verifyQuote('nd he said', passage), '');
  assert.equal(verifyQuote('', passage), '');
  assert.equal(verifyQuote(undefined, passage), '');
  assert.equal(verifyQuote('so he kept going', ''), '');
  const long = Array.from({ length: 70 }, (_, i) => `w${i}`).join(' ');
  assert.equal(verifyQuote(long, long), '');
});

test('cleanNote normalises the rewrite answer', () => {
  const note = cleanNote({
    title: ' Love drives greatness ', idea: 'Idea.', speaker: 'Rick', category: 'Creativity ',
    tags: ['Taste', 'taste', 'Work Ethic', 'x', 'y'], quote: 'You cannot be great.',
  }, passage);
  assert.deepEqual(note, {
    title: 'Love drives greatness', idea: 'Idea.', points: [], speaker: 'Rick', category: 'creativity',
    tags: ['taste', 'work-ethic', 'x', 'y'], quote: '',
  });
  assert.deepEqual(cleanNote(null, passage), { title: '', idea: '', points: [], speaker: '', category: '', tags: [], quote: '' });
});

test('clip links start two seconds early and stop at the end of the passage', () => {
  const bm = { media_id: 'abcd1234567', span: { start: 99.4, end: 146.2 } };
  assert.equal(playUrl(bm), 'https://www.youtube.com/watch?v=abcd1234567&t=97s');
  assert.equal(clipUrl(bm), 'https://www.youtube.com/embed/abcd1234567?start=97&end=147');
  assert.equal(clipUrl(bm, { autoplay: true }), 'https://www.youtube.com/embed/abcd1234567?start=97&end=147&autoplay=1');
  assert.equal(clipUrl({ media_id: 'x', span: { start: 0.5, end: 0.6 } }), 'https://www.youtube.com/embed/x?start=0&end=1');
});

const baseBm = {
  id: '2026-11-18T09-14-07-123Z-abcd', source: 'youtube', media_id: 'abcd1234567', title: 'T', channel: 'Chan',
  t_press: 150, width: 'normal', pressed_at: '2026-11-18T09:14:07.123Z', captions: 'auto',
  span: { start: 99, end: 147, confidence: 'high', needs_review: false }, transcript_span: 'line33 line34',
};

test('note frontmatter carries category and tags, and the body the quote', () => {
  const md = renderNote({ ...baseBm, note: { title: 'X', idea: 'Y', speaker: '', category: 'creativity', tags: ['taste', 'work-ethic'], quote: 'line33 line34' } });
  assert.ok(md.includes('\ncategory: "creativity"\n'));
  assert.ok(md.includes('\ntags: ["taste", "work-ethic"]\n'));
  assert.ok(md.includes('\n> “line33 line34”\n'));
});

test('old bookmarks without category, tags, or quote still render', () => {
  const md = renderNote({ ...baseBm, note: { title: 'X', idea: 'Y', speaker: '' } });
  assert.ok(md.includes('\ncategory: ""\n'));
  assert.ok(md.includes('\ntags: []\n'));
  assert.ok(!md.includes('“'));
  assert.ok(md.includes('> line33 line34'));
});

test('points are cleaned, capped and rendered as bullets', async () => {
  const { cleanPoints, REWRITE_SCHEMA } = await import('../lib/pipeline.js');
  const pts = cleanPoints([
    { emoji: ' 🎧 ', label: ' Listen first ', text: ' He listens before he speaks. ' },
    { emoji: '', label: '', text: 'No label here.' },
    { emoji: '🙂', label: 'Empty', text: '  ' },
    null,
    ...Array.from({ length: 9 }, (_, i) => ({ emoji: '•', label: `L${i}`, text: `T${i}` })),
  ]);
  assert.equal(pts.length, 6);
  assert.deepEqual(pts[0], { emoji: '🎧', label: 'Listen first', text: 'He listens before he speaks.' });
  assert.deepEqual(cleanPoints('nope'), []);
  assert.deepEqual(REWRITE_SCHEMA.properties.points.items.required, ['emoji', 'label', 'text']);
  assert.equal(REWRITE_SCHEMA.properties.points.items.additionalProperties, false);
  const md = renderNote({
    id: '2026-11-18T09-14-07-123Z-abcd', source: 'youtube', media_id: 'abcd1234567', title: 'V', channel: 'C',
    t_press: 150, width: 'normal', pressed_at: '2026-11-18T09:14:07.123Z',
    span: { start: 99, end: 147, confidence: 'high', needs_review: false },
    note: { title: 'T', idea: 'Gist.', points: pts.slice(0, 2), speaker: '' }, transcript_span: 'x',
  });
  assert.ok(md.includes('- **Listen first:** He listens before he speaks.'));
  assert.ok(md.includes('- No label here.'));
});

test('readEvents picks the completed or failed event from an Outlet stream', async () => {
  const { readEvents } = await import('../lib/outlet.js');
  const ok = 'event: started\ndata: {"requestId":"a"}\n\nevent: completed\ndata: {"output":{"x":1}}\n\n';
  assert.deepEqual(readEvents(ok).completed.output, { x: 1 });
  const bad = 'event: started\r\ndata: {}\r\n\r\nevent: failed\r\ndata: {"code":"busy","message":"Busy"}\r\n\r\n';
  assert.deepEqual(readEvents(bad), { failed: { code: 'busy', message: 'Busy' } });
  assert.deepEqual(readEvents('event: started\ndata: {}\n\n'), {});
});

test('cleanDetails keeps sections with points, caps sizes, and renders as Markdown', async () => {
  const { cleanDetails, renderDetails } = await import('../lib/pipeline.js');
  const d = cleanDetails({
    sections: [
      { heading: ' The claim ', points: [{ text: 'Formal verification matters most.', sub: ['Lean', '', 'unit tests', 'static typing', 'extra'] }, { text: '  ', sub: [] }] },
      { heading: 'Empty', points: [] },
    ],
    terms: [{ term: 'Lean', meaning: 'A proof assistant.' }, { term: '', meaning: 'x' }],
    takeaway: ' Prove it, do not review it. ',
  });
  assert.equal(d.sections.length, 1);
  assert.deepEqual(d.sections[0], { heading: 'The claim', points: [{ text: 'Formal verification matters most.', sub: ['Lean', 'unit tests', 'static typing'] }] });
  assert.equal(d.terms.length, 1);
  const md = renderDetails(d).join('\n');
  assert.match(md, /\*\*Remember:\*\* Prove it, do not review it\./);
  assert.match(md, /### The claim\n\n- Formal verification matters most\.\n {2}- Lean/);
  assert.throws(() => cleanDetails({ sections: [], terms: [], takeaway: '' }));
});
