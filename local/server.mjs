#!/usr/bin/env node
// Local bridge: lets the Earmark extension use the Codex CLI already signed in
// on this machine. Listens on loopback only and accepts requests only from
// browser extensions. Codex runs with its tools disabled and a read-only
// sandbox in an empty temporary folder: it is used purely for text generation.
//
//   node local/server.mjs            (port 8765, or EARMARK_PORT)
//
// The invocation follows bring-ai/src/providers/codex.mjs in this repository.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.EARMARK_PORT || 8765);
const CODEX = process.env.EARMARK_CODEX_BIN || 'codex';
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const DISABLED = [
  'shell_tool', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'hooks', 'memories',
  'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image',
  'skill_search', 'sleep_tool', 'goals', 'shell_snapshot', 'request_permissions_tool',
  'tool_suggest', 'code_mode_host',
];

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseCodex(stdout, code) {
  let text = '', usage = null, completed = false, failed = false, tools = false, detail = '';
  for (const line of stdout.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'turn.completed') { completed = true; usage = ev.usage || null; }
    if (ev.type === 'error' || ev.type === 'turn.failed') {
      failed = true;
      detail = ev.message || ev.error?.message || detail;
    }
    if (ev.item?.type === 'agent_message') text = ev.item.text || text;
    if (ev.item && !['agent_message', 'reasoning', 'error'].includes(ev.item.type)) tools = true;
  }
  if (tools) throw new BridgeError(502, 'Codex tried to use a tool; the request was discarded.');
  if (code !== 0 || !completed || failed || !text) {
    throw new BridgeError(502, `Codex could not complete the request. ${detail || 'Check its sign-in and usage allowance.'}`.trim());
  }
  return { text, usage };
}

async function generate({ prompt, schema, model, effort }) {
  const dir = await mkdtemp(join(tmpdir(), 'earmark-'));
  try {
    const args = [
      '--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--ephemeral', '--sandbox', 'read-only', '--json', '--color', 'never',
    ];
    for (const flag of DISABLED) args.push('--disable', flag);
    args.push('--model', model);
    for (const setting of [
      'web_search="disabled"',
      'skills.include_instructions=false',
      'skills.bundled.enabled=false',
      'agents.enabled=false',
      'features.skip_host_skill_discovery=true',
      `model_reasoning_effort="${effort}"`,
    ]) args.push('-c', setting);
    if (schema) {
      const file = join(dir, 'schema.json');
      await writeFile(file, JSON.stringify(schema), { mode: 0o600 });
      args.push('--output-schema', file);
    }
    args.push('-');

    const { stdout, code } = await new Promise((resolve, reject) => {
      const child = spawn(CODEX, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let out = '';
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(() => { kill(); reject(new BridgeError(504, 'Codex took too long.')); }, TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.resume();
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new BridgeError(500, e.code === 'ENOENT' ? 'The codex command was not found.' : e.message));
      });
      child.on('close', (c) => { clearTimeout(timer); resolve({ stdout: out, code: c }); });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });

    const { text, usage } = parseCodex(stdout, code);
    if (!schema) return { output: text, usage };
    try {
      return { output: JSON.parse(text), usage };
    } catch {
      throw new BridgeError(502, 'Codex returned something that is not valid JSON.');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BridgeError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// One request at a time: presses are rare and Codex runs are heavy.
let queue = Promise.resolve();

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Only browser extensions may call this. A web page cannot forge its Origin,
  // so this keeps arbitrary sites from spending the local Codex allowance.
  const origin = req.headers.origin || '';
  if (!origin.startsWith('chrome-extension://')) return send(403, { error: 'Forbidden.' });

  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/generate') return send(404, { error: 'Not found.' });

    const body = JSON.parse(await readBody(req));
    const { prompt, schema } = body;
    const model = String(body.model || 'gpt-6.1-sol');
    const effort = String(body.effort || 'medium');
    if (typeof prompt !== 'string' || !prompt) throw new BridgeError(400, 'Missing prompt.');
    if (!/^[\w.:-]{1,64}$/.test(model)) throw new BridgeError(400, 'Invalid model name.');
    if (!EFFORTS.has(effort)) throw new BridgeError(400, 'Invalid effort.');

    const started = Date.now();
    const run = queue.then(() => generate({ prompt, schema, model, effort }));
    queue = run.catch(() => {});
    const result = await run;
    console.log(`${new Date().toISOString()} ok ${model}/${effort} ${((Date.now() - started) / 1000).toFixed(1)}s`);
    send(200, result);
  } catch (e) {
    const status = e instanceof BridgeError ? e.status : e instanceof SyntaxError ? 400 : 500;
    console.log(`${new Date().toISOString()} error ${status} ${e.message}`);
    send(status, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Earmark local bridge listening on http://127.0.0.1:${PORT} (Codex CLI: ${CODEX})`);
});
