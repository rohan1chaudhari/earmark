// Outlet: the user's own AI, through the Outlet desktop connector
// (https://github.com/rohan1chaudhari/outlet). Earmark pairs once (the user compares a six-digit code and
// allows it in Outlet's window), then sends each model call with the token.
// Protocol: docs/protocol.md in the Outlet repository. Works in a page and in the worker.

export const OUTLET_URL = 'http://127.0.0.1:4360';
export const PAIRING = {
  name: 'Earmark',
  purpose: 'Turns the passage you bookmark in a YouTube video into a short note. Sends that video\'s transcript.',
  requires: ['text', 'structuredOutput'],
};

export class OutletError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Errors that clear on their own or after the user acts in Outlet: keep the
// press queued and try again later instead of marking it failed.
export const TRANSIENT = new Set([
  'connector_unreachable', 'busy', 'paused', 'rate_limited', 'outcome_unknown', 'cancelled',
  'session_expired', 'allowance_exhausted', 'not_connected',
]);
// Errors after which the saved token is useless.
export const ENDS_SESSION = new Set(['session_expired', 'allowance_exhausted']);

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function call(base, path, { token, body, method = 'POST', timeout = 60000, signal } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, '') + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (deadline.aborted) throw new OutletError('outcome_unknown', 'Outlet took too long to answer.');
    throw new OutletError('connector_unreachable', 'Outlet is not running. Open Outlet on this computer.');
  }
  if (!res.ok) {
    let error = {};
    try { error = (await res.json()).error || {}; } catch {}
    throw new OutletError(error.code || 'connector_error', error.message || `Outlet answered with an error (${res.status}).`);
  }
  return res;
}

// True when something answers on Outlet's port. Chrome may leave the Origin
// header off an extension's GET, which Outlet refuses, so any answer counts.
export async function outletRunning(base = OUTLET_URL) {
  try {
    await fetch(`${base.replace(/\/+$/, '')}/v1/info`, { signal: AbortSignal.timeout(3000), credentials: 'omit', cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

// Ask Outlet for a session. `onCode` receives the six-digit code to show
// while the user approves in Outlet. Resolves with the session receipt.
export async function pairOutlet(base = OUTLET_URL, { onCode, signal } = {}) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const pairing = await (await call(base, '/v1/pairings', { body: { ...PAIRING, codeChallenge: challenge }, signal })).json();
  if (pairing.status === 'pending') onCode?.(pairing.verificationCode, pairing.expiresAt);
  while (Date.now() < pairing.expiresAt) {
    const receipt = await (await call(base, '/v1/pairings/exchange', { body: { pairingId: pairing.pairingId, codeVerifier: verifier }, signal })).json();
    if (!receipt.pending) return receipt;
    await new Promise((r) => setTimeout(r, 1000));
    if (signal?.aborted) throw signal.reason;
  }
  throw new OutletError('pairing_expired', 'The request expired before it was allowed in Outlet. Connect again.');
}

// One structured generation. Outlet answers with server-sent events and
// checks the output against the schema before sending `completed`.
export async function outletGenerate(base, token, { messages, outputSchema }) {
  const res = await call(base, '/v1/generate', {
    token,
    body: { requestId: crypto.randomUUID(), messages, ...(outputSchema ? { outputSchema } : {}) },
    timeout: 315000,
  });
  let text;
  try { text = await res.text(); } catch { throw new OutletError('outcome_unknown', 'The connection to Outlet was interrupted.'); }
  const { completed, failed } = readEvents(text);
  if (failed) throw new OutletError(failed.code || 'connector_error', failed.message || 'Outlet could not complete the request.');
  if (!completed) throw new OutletError('outcome_unknown', 'Outlet stopped before the answer was complete.');
  return completed.output;
}

export function readEvents(text) {
  const out = {};
  for (const frame of String(text).replace(/\r\n/g, '\n').split('\n\n')) {
    let event = '';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length || (event !== 'completed' && event !== 'failed')) continue;
    try { out[event] = JSON.parse(data.join('\n')); } catch {}
  }
  return out;
}
