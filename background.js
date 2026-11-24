// Background worker: press queue, model calls, notes.
// A press is written to storage before anything else happens, so it survives
// a missing key, a network failure, or the worker being shut down.
import {
  SYSTEM, SPAN_SCHEMA, REWRITE_SCHEMA, SPEAKERS_SCHEMA, speakersTask, cleanTurns, DETAILS_SCHEMA, detailsTask, cleanDetails,
  transcriptBlock, spanTask, rewriteTask, resolveSpan, fullSpan, spanText, cleanNote, renderNote, noteFilename,
} from './lib/pipeline.js';
import { collectVocabulary } from './lib/library.js';
import { OUTLET_URL, outletGenerate, TRANSIENT, ENDS_SESSION } from './lib/outlet.js';

const get = async (key) => (await chrome.storage.local.get(key))[key];
const set = (key, value) => chrome.storage.local.set({ [key]: value });

async function settings() {
  return {
    provider: 'outlet', codexModel: 'gpt-6.1-sol', codexEffort: 'medium', bridgeUrl: 'http://127.0.0.1:8765',
    downloadNotes: false, folder: 'earmark', outletUrl: OUTLET_URL,
    ...((await get('settings')) || {}),
  };
}

class RetryLater extends Error {}

// Local Codex CLI, through the bridge in local/server.mjs.
async function callCodex(cfg, block, task, schema) {
  const prompt = [
    SYSTEM,
    'Answer only with the JSON object the task asks for. Do not run commands or use tools; everything you need is below.',
    '',
    block,
    '',
    task,
  ].join('\n');
  let res;
  try {
    res = await fetch(`${cfg.bridgeUrl.replace(/\/+$/, '')}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, schema, model: cfg.codexModel, effort: cfg.codexEffort }),
    });
  } catch {
    throw new RetryLater('The local bridge is not running. Start it with: node local/server.mjs');
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 504) throw new RetryLater(data.error || 'Codex took too long.');
  if (!res.ok) throw new Error(data.error || `Local bridge error (${res.status}).`);
  return data.output;
}

function callModel(cfg, block, task, schema) {
  if (cfg.provider === 'outlet') return callOutlet(cfg, block, task, schema);
  return callCodex(cfg, block, task, schema);
}

// Outlet runs one request at a time and answers "busy" to a second, so calls
// from here wait for each other. The model and its effort are chosen in Outlet.
let outletQueue = Promise.resolve();
function callOutlet(cfg, block, task, schema) {
  const run = outletQueue.then(() => outletCall(cfg, block, task, schema));
  outletQueue = run.catch(() => {});
  return run;
}

async function outletCall(cfg, block, task, schema) {
  const conn = await get('outlet');
  if (!conn?.token || conn.expiresAt <= Date.now()) {
    throw new RetryLater('Connect Earmark to Outlet in Earmark options.');
  }
  try {
    return await outletGenerate(cfg.outletUrl || OUTLET_URL, conn.token, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${block}\n\n${task}` },
      ],
      outputSchema: schema,
    });
  } catch (e) {
    if (ENDS_SESSION.has(e.code)) {
      await chrome.storage.local.remove('outlet');
      throw new RetryLater(`${e.message} Reconnect in Earmark options.`);
    }
    if (TRANSIENT.has(e.code)) throw new RetryLater(e.message);
    throw new Error(e.message);
  }
}

function saveNoteFile(cfg, bm) {
  // Off by default: the note lives with its bookmark in the library.
  if (!cfg.downloadNotes) return;
  const folder = (cfg.folder || 'earmark').replace(/^[\/.]+|\/+$/g, '') || 'earmark';
  const url = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(renderNote(bm));
  // Re-saving after a correction replaces the earlier file of the same name.
  chrome.downloads.download({ url, filename: `${folder}/${bm.file}`, conflictAction: 'overwrite', saveAs: false });
}

const busy = new Set();

// Tell the YouTube tab that made the press how its note is coming along.
function notify(bm, stage, extra = {}) {
  if (bm.tab_id == null) return;
  chrome.tabs.sendMessage(bm.tab_id, { type: 'earmark:status', id: bm.id, t_press: bm.t_press, stage, ...extra }).catch(() => {});
}

function updateBadge() {
  chrome.action.setBadgeBackgroundColor({ color: '#b5482a' });
  chrome.action.setBadgeText({ text: busy.size ? '…' : '' });
}

async function processBookmark(id, hint) {
  if (busy.has(id)) return;
  busy.add(id);
  updateBadge();
  try {
    let bm = await get(`bm:${id}`);
    if (!bm) return;
    const cfg = await settings();
    const tr = await get(`tr:${bm.media_id}`);
    if (!tr || !tr.segments?.length) {
      await set(`bm:${id}`, bm.no_captions
        ? { ...bm, status: 'no-transcript', message: 'This video has no captions. The position link still works.' }
        : { ...bm, status: 'waiting-transcript', message: 'The captions could not be read yet. Earmark keeps trying while the video is open, and again the next time you open it.' });
      notify(bm, bm.no_captions ? 'no-captions' : 'waiting');
      return;
    }
    await set(`bm:${id}`, { ...bm, status: 'processing', stage: 'span', message: '' });
    notify(bm, 'span');

    const block = transcriptBlock(bm, tr.segments);
    // Pressed twice: the whole video, so there is no passage to guess. A later
    // Wider/Narrower correction goes back to guessing around the press.
    const span = bm.width === 'full' && !hint
      ? fullSpan(tr.segments)
      : resolveSpan(await callModel(cfg, block, spanTask(bm, hint), SPAN_SCHEMA), tr.segments, bm);
    await set(`bm:${id}`, { ...((await get(`bm:${id}`)) || bm), stage: 'rewrite' });
    notify(bm, 'rewrite');
    // Tags already used elsewhere, so the model reuses them rather than inventing synonyms.
    const vocab = collectVocabulary(await allBookmarks());
    const passage = spanText(tr.segments, span.start, span.end);
    const note = cleanNote(await callModel(cfg, block, rewriteTask(span, vocab), REWRITE_SCHEMA), passage);

    bm = (await get(`bm:${id}`)) || bm;
    const done = {
      ...bm,
      status: 'ok',
      message: '',
      span,
      note,
      captions: tr.kind,
      transcript_span: passage,
      model: cfg.provider === 'outlet' ? `outlet: ${(await get('outlet'))?.model || 'default'}` : `${cfg.codexModel} (${cfg.codexEffort})`,
      processed_at: new Date().toISOString(),
    };
    // Keep one file per bookmark even when a correction changes its title.
    done.file = bm.file || noteFilename(done);
    delete done.stage;
    await set(`bm:${id}`, done);
    if (!bm.span || bm.span.start !== span.start || bm.span.end !== span.end) await chrome.storage.local.remove(`dt:${id}`);
    saveNoteFile(cfg, done);
    notify(done, 'done', { title: note.title });
  } catch (e) {
    const bm = await get(`bm:${id}`);
    if (bm) {
      const retry = e instanceof RetryLater;
      await set(`bm:${id}`, { ...bm, status: retry ? 'queued' : 'error', message: e.message });
      notify(bm, retry ? 'queued' : 'error', { message: e.message });
    }
  } finally {
    busy.delete(id);
    updateBadge();
  }
}

async function allBookmarks() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('bm:'))
    .map(([, v]) => v)
    .sort((a, b) => b.pressed_at.localeCompare(a.pressed_at));
}

async function retryQueued() {
  for (const bm of await allBookmarks()) {
    // "processing" with no live job means the worker was shut down mid-call.
    if (bm.status === 'queued' || (bm.status === 'processing' && !busy.has(bm.id))) {
      await processBookmark(bm.id);
    }
  }
}

async function logCorrection(bm, kind) {
  const log = (await get('corrections')) || [];
  log.push({
    at: new Date().toISOString(),
    id: bm.id,
    media_id: bm.media_id,
    kind,
    t_press: bm.t_press,
    width: bm.width,
    span: bm.span ? { start: bm.span.start, end: bm.span.end, confidence: bm.span.confidence, source: bm.span.source } : null,
    model: bm.model || null,
  });
  await set('corrections', log);
}

// Speaker turns for a video's transcript: worked out once, on first request,
// and saved with the transcript. Requests for the same video share one call.
const labelling = new Map();
function labelSpeakers(mediaId) {
  if (labelling.has(mediaId)) return labelling.get(mediaId);
  const job = (async () => {
    const tr = await get(`tr:${mediaId}`);
    if (!tr?.segments?.length) return { ok: false, error: 'No transcript is saved for this video.' };
    if (tr.turns?.length) return { ok: true, turns: tr.turns };
    const meta = (await allBookmarks()).find((b) => b.media_id === mediaId) || {};
    try {
      const turns = cleanTurns(await callModel(await settings(), transcriptBlock(meta, tr.segments), speakersTask(), SPEAKERS_SCHEMA), tr.segments);
      if (!turns.length) return { ok: false, error: 'The model could not tell the speakers apart.' };
      // Read again: the transcript may have been replaced while the model worked.
      const now = (await get(`tr:${mediaId}`)) || tr;
      await set(`tr:${mediaId}`, { ...now, turns });
      return { ok: true, turns };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })().finally(() => labelling.delete(mediaId));
  labelling.set(mediaId, job);
  return job;
}

// Detailed notes for one bookmark: written the first time they are asked for,
// and kept under their own key so saving them does not redraw the library.
const detailing = new Map();
function writeDetails(id) {
  if (detailing.has(id)) return detailing.get(id);
  const job = (async () => {
    const saved = await get(`dt:${id}`);
    if (saved?.sections?.length) return { ok: true, details: saved };
    const bm = await get(`bm:${id}`);
    if (!bm?.span || !bm.note) return { ok: false, error: 'This note is not ready yet.' };
    const tr = await get(`tr:${bm.media_id}`);
    if (!tr?.segments?.length) return { ok: false, error: 'The transcript for this video is no longer saved.' };
    try {
      const cfg = await settings();
      const details = cleanDetails(await callModel(cfg, transcriptBlock(bm, tr.segments), detailsTask(bm.span, bm.note), DETAILS_SCHEMA));
      // The passage may have changed (wider / narrower) while the model worked.
      const now = await get(`bm:${id}`);
      if (!now || now.span?.start !== bm.span.start || now.span?.end !== bm.span.end) return { ok: false, error: 'The passage changed. Open Details again.' };
      await set(`dt:${id}`, details);
      return { ok: true, details };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })().finally(() => detailing.delete(id));
  detailing.set(id, job);
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'earmark:press') {
      const { press, transcript } = msg;
      if (transcript) await set(`tr:${press.media_id}`, transcript);
      await set(`bm:${press.id}`, { ...press, tab_id: sender.tab?.id ?? null, no_captions: !!msg.no_captions, status: 'queued', message: '' });
      processBookmark(press.id);
      return { ok: true };
    }
    if (msg.type === 'earmark:open-library') {
      // Must be called straight away, while the click still counts as the
      // user's own action; Chrome refuses to open the panel otherwise.
      try {
        await chrome.sidePanel.open({ tabId: sender.tab.id });
      } catch {
        chrome.tabs.create({ url: chrome.runtime.getURL('bookmarks.html') });
      }
      return { ok: true };
    }
    if (msg.type === 'earmark:pending') {
      const all = await allBookmarks();
      return { pending: all.some((b) => b.media_id === msg.media_id && b.status === 'waiting-transcript') };
    }
    if (msg.type === 'earmark:transcript') {
      // Captions arrived (or turned out not to exist) after the press.
      if (msg.transcript) await set(`tr:${msg.media_id}`, msg.transcript);
      for (const bm of await allBookmarks()) {
        if (bm.media_id !== msg.media_id || bm.status !== 'waiting-transcript') continue;
        await set(`bm:${bm.id}`, { ...bm, no_captions: !msg.transcript, status: 'queued', message: '' });
        processBookmark(bm.id);
      }
      return { ok: true };
    }
    if (msg.type === 'earmark:speakers') return labelSpeakers(msg.media_id);
    if (msg.type === 'earmark:details') return writeDetails(msg.id);
    if (msg.type === 'earmark:list') {
      return { bookmarks: await allBookmarks(), corrections: (await get('corrections')) || [] };
    }
    if (msg.type === 'earmark:correct') {
      const bm = await get(`bm:${msg.id}`);
      if (!bm) return { ok: false };
      await logCorrection(bm, msg.kind);
      // The first verdict on a bookmark is the one that counts for the accuracy test.
      if (msg.kind === 'right' || msg.kind === 'wrong') {
        await set(`bm:${bm.id}`, { ...bm, verdict: bm.verdict || msg.kind });
      } else if (bm.span) {
        await set(`bm:${bm.id}`, { ...bm, verdict: bm.verdict || msg.kind });
        processBookmark(bm.id, { kind: msg.kind, start: bm.span.start, end: bm.span.end });
      }
      return { ok: true };
    }
    if (msg.type === 'earmark:retry') {
      const bm = await get(`bm:${msg.id}`);
      if (bm) {
        await set(`bm:${bm.id}`, { ...bm, status: 'queued', message: '' });
        processBookmark(bm.id);
      }
      return { ok: true };
    }
    if (msg.type === 'earmark:delete') {
      await chrome.storage.local.remove([`bm:${msg.id}`, `dt:${msg.id}`]);
      return { ok: true };
    }
    if (msg.type === 'earmark:wipe') {
      // Everything except settings: bookmarks, cached transcripts, the correction log.
      const all = await chrome.storage.local.get(null);
      // The Outlet connection is a setting too: keep it.
      const keys = Object.keys(all).filter((k) => k !== 'settings' && k !== 'outlet');
      await chrome.storage.local.remove(keys);
      return { ok: true, removed: keys.filter((k) => k.startsWith('bm:')).length };
    }
    if (msg.type === 'earmark:settings-changed') {
      retryQueued();
      return { ok: true };
    }
    return undefined;
  })().then(sendResponse);
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'bookmark') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id && tab.url?.startsWith('https://www.youtube.com/')) {
    chrome.tabs.sendMessage(tab.id, { type: 'earmark:hotkey' }).catch(() => {});
  }
});

// The library opens beside the page you are on, not in a new tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// YouTube tabs that were already open still hold the previous, now dead, copy
// of the capture script. Give them a fresh one so no tab reload is needed.
async function reviveOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch {}
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create('earmark-retry', { periodInMinutes: 5 });
  reviveOpenTabs();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('earmark-retry', { periodInMinutes: 5 });
  retryQueued();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'earmark-retry') retryQueued();
});
