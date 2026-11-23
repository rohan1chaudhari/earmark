import { OUTLET_URL, outletRunning, pairOutlet } from './lib/outlet.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  provider: 'outlet', codexModel: 'gpt-6.1-sol', codexEffort: 'medium', bridgeUrl: 'http://127.0.0.1:8765',
  downloadNotes: false, folder: 'earmark', outletUrl: OUTLET_URL,
};
const TEXT = ['codexModel', 'bridgeUrl', 'folder'];
const SELECT = ['provider', 'codexEffort'];

function showProvider() {
  const p = $('provider').value;
  $('codexBox').hidden = p !== 'codex';
  $('outletBox').hidden = p !== 'outlet';
  if (p === 'codex') checkBridge();
  if (p === 'outlet') showOutlet();
}

// --- Outlet ---------------------------------------------------------------

const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function showOutlet() {
  const { outlet } = await chrome.storage.local.get('outlet');
  const live = outlet?.token && outlet.expiresAt > Date.now();
  $('outletConnect').textContent = live ? 'Connect again' : 'Connect to Outlet';
  $('outletDisconnect').hidden = !live;
  if (live) {
    const model = outlet.model && !outlet.model.endsWith('-default') ? ` ${outlet.model}` : '';
    $('outletState').textContent = `Connected: ${outlet.provider || 'AI'}${model}, approved for ${outlet.remaining} requests, until ${when(outlet.expiresAt)}.`;
    return;
  }
  $('outletState').textContent = (await outletRunning())
    ? 'Outlet is running. Earmark is not connected yet.'
    : 'Outlet is not running. Open Outlet on this computer, then connect.';
}

let pairing = null;
$('outletConnect').addEventListener('click', async () => {
  pairing?.abort();
  const ctrl = (pairing = new AbortController());
  $('outletConnect').disabled = true;
  $('outletState').textContent = 'Asking Outlet…';
  try {
    const receipt = await pairOutlet(OUTLET_URL, {
      signal: ctrl.signal,
      onCode: (code) => {
        $('outletDigits').textContent = code;
        $('outletCode').hidden = false;
        $('outletState').textContent = 'Waiting for you to allow Earmark in Outlet…';
      },
    });
    const { token, expiresAt, remaining, provider, model } = receipt;
    await chrome.storage.local.set({ outlet: { token, expiresAt, remaining, provider, model, connectedAt: Date.now() } });
    // Use Outlet from now on, and let queued presses go through.
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(settings || {}), provider: 'outlet' } });
    chrome.runtime.sendMessage({ type: 'earmark:settings-changed' });
    await showOutlet();
  } catch (e) {
    if (!ctrl.signal.aborted) $('outletState').textContent = e.code === 'permission_denied' ? 'You declined Earmark in Outlet.' : e.message;
  } finally {
    $('outletCode').hidden = true;
    $('outletConnect').disabled = false;
  }
});

$('outletDisconnect').addEventListener('click', async () => {
  const { outlet } = await chrome.storage.local.get('outlet');
  await chrome.storage.local.remove('outlet');
  // Ask Outlet to end the session too; it is already forgotten here either way.
  if (outlet?.token) {
    fetch(`${OUTLET_URL}/v1/session`, { method: 'DELETE', headers: { authorization: `Bearer ${outlet.token}` } }).catch(() => {});
  }
  showOutlet();
});

async function checkBridge() {
  const url = ($('bridgeUrl').value.trim() || DEFAULTS.bridgeUrl).replace(/\/+$/, '');
  $('health').textContent = '';
  try {
    const res = await fetch(`${url}/health`);
    $('health').textContent = res.ok ? 'Bridge is running.' : 'Bridge answered with an error.';
  } catch {
    $('health').textContent = 'Bridge is not running right now.';
  }
}

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const id of [...TEXT, ...SELECT]) $(id).value = s[id];
  $('downloadNotes').checked = s.downloadNotes;
  showFolder();
  showProvider();
})();

function showFolder() { $('folderBox').hidden = !$('downloadNotes').checked; }
$('downloadNotes').addEventListener('change', showFolder);
$('provider').addEventListener('change', showProvider);
$('bridgeUrl').addEventListener('change', checkBridge);

$('save').addEventListener('click', async () => {
  const s = { downloadNotes: $('downloadNotes').checked };
  for (const id of TEXT) s[id] = $(id).value.trim() || DEFAULTS[id];
  for (const id of SELECT) s[id] = $(id).value;
  await chrome.storage.local.set({ settings: s });
  chrome.runtime.sendMessage({ type: 'earmark:settings-changed' });
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
});

$('wipe').addEventListener('click', async () => {
  if (!window.confirm('Delete every bookmark, saved transcript and the accuracy log? This cannot be undone.')) return;
  const res = await chrome.runtime.sendMessage({ type: 'earmark:wipe' });
  $('wiped').textContent = res && res.ok ? `Deleted ${res.removed} bookmark${res.removed === 1 ? '' : 's'}.` : 'Could not delete the data.';
});
