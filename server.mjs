// Embody ASCII bridge: serves the 3D ASCII client and relays it to the Embody
// MCP server over streamable HTTP. Zero dependencies (Node 18+).
//
// Low-latency design
//  - MCP sessions are opened at startup and kept warm (keep-alive sockets).
//  - A watcher session long-polls wait(full=true): the server answers the
//    moment something touches you, with the full perception in the same
//    round trip. That state is pushed to the page over SSE immediately.
//  - Actions run on a separate session so they never queue behind the poll;
//    the bridge answers the page as soon as the act returns, then refreshes.
//  - Pushes are ordered by world time so a slow reply never overwrites a
//    newer one.
//
// Credentials: read at startup from the "embody" entry in ~/.claude.json
// (the same grant Claude Code uses), or from EMBODY_URL / EMBODY_TOKEN.
// The token never leaves this process; the page only talks to 127.0.0.1.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4477;

function loadConfig() {
  if (process.env.EMBODY_URL) {
    const headers = {};
    if (process.env.EMBODY_TOKEN) headers.Authorization = `Bearer ${process.env.EMBODY_TOKEN}`;
    return { url: process.env.EMBODY_URL, headers };
  }
  const file = path.join(os.homedir(), '.claude.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read ${file}: ${e.message}. Set EMBODY_URL and EMBODY_TOKEN instead.`);
  }
  const entry = cfg.mcpServers?.embody;
  if (!entry?.url) throw new Error('No "embody" server in ~/.claude.json mcpServers. Set EMBODY_URL and EMBODY_TOKEN instead.');
  return { url: entry.url, headers: entry.headers || {} };
}

// ---------------------------------------------------------------- MCP client
class McpClient {
  constructor({ url, headers }, label) {
    this.url = url;
    this.headers = headers;
    this.label = label;
    this.sessionId = null;
    this.protocol = null;
    this.nextId = 1;
    this.ready = null;
  }

  async post(message, expectReply = true) {
    const headers = {
      ...this.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocol) headers['MCP-Protocol-Version'] = this.protocol;

    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (!expectReply) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/event-stream')) return res.json();

    // SSE reply: read frames until the one carrying our id arrives.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg.id === message.id) {
          reader.cancel().catch(() => {});
          return msg;
        }
      }
    }
    throw new Error('MCP stream closed before replying');
  }

  async init() {
    this.sessionId = null;
    this.protocol = null;
    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'embody-ascii', version: '0.2.0' },
      },
    });
    if (reply.error) throw new Error(`initialize: ${reply.error.message}`);
    this.protocol = reply.result?.protocolVersion || '2025-06-18';
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    console.log(`[${this.label}] session ready`);
  }

  ensure() {
    if (!this.ready) this.ready = this.init().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async callOnce(name, args) {
    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args || {} },
    });
    if (reply.error) return { error: reply.error.message };
    const r = reply.result || {};
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    let data = r.structuredContent;
    if (data === undefined) {
      try { data = JSON.parse(text); } catch { data = { result: text }; }
    }
    if (r.isError) return { error: data?.result ?? data?.error ?? (text || 'error') };
    return data;
  }

  async call(name, args) {
    await this.ensure();
    let out;
    try {
      out = await this.callOnce(name, args);
    } catch (e) {
      // Session expired or the server restarted: open a new session, retry once.
      if (![400, 401, 404].includes(e.status)) throw e;
      this.ready = null;
      await this.ensure();
      out = await this.callOnce(name, args);
    }
    // The world forgot us (it restarted, or the seat timed out): take the grant's seat again, retry once.
    if (name !== 'join' && notSeated(out)) {
      const j = await this.callOnce('join', seat.entity ? { entity: seat.entity, ...(seat.world ? { world_id: seat.world } : {}) } : {});
      if (j?.error || j?.result?.ok === false) {
        const why = j?.error || j?.result?.reason || 'refused';
        if (why !== this.joinRefused) console.error(`[${this.label}] could not take your seat: ${why}`);
        this.joinRefused = why;
        return out;
      }
      this.joinRefused = null;
      console.log(`[${this.label}] rejoined your seat`);
      out = await this.callOnce(name, args);
    }
    return out;
  }
}

function notSeated(out) {
  const r = out?.result;
  return r?.ok === false && /not in this world|join\(/i.test(`${r.reason || ''} ${r.hint || ''}`);
}

// The character we play, so a dropped seat can be taken again: EMBODY_ENTITY if set,
// otherwise the last one the world showed us (kept in .seat.json beside this file).
const SEAT_FILE = path.join(HERE, '.seat.json');
const seat = (() => { try { return JSON.parse(fs.readFileSync(SEAT_FILE, 'utf8')) || {}; } catch { return {}; } })();
if (process.env.EMBODY_ENTITY) seat.entity = process.env.EMBODY_ENTITY;
function rememberSeat(state) {
  const entity = state?.you?.id, world = state?.world;
  if (!entity || process.env.EMBODY_ENTITY) return;
  if (entity === seat.entity && (!world || world === seat.world)) return;
  seat.entity = entity;
  if (world) seat.world = world;
  try { fs.writeFileSync(SEAT_FILE, JSON.stringify(seat)); } catch {}
}

// ---------------------------------------------------------------- state hub
const config = loadConfig();
const main = new McpClient(config, 'main');
const watcher = new McpClient(config, 'watch');

const clients = new Set();
let latest = null;        // last perception pushed
let latestT = -Infinity;  // its world time
let backlog = [];         // recent events for a freshly opened page

function broadcast(msg) {
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(frame);
}

function rememberEvents(events) {
  if (!events?.length) return;
  const seen = new Set(backlog.map((e) => e.seq));
  for (const e of events) if (!seen.has(e.seq)) backlog.push(e);
  backlog.sort((a, b) => a.seq - b.seq);
  if (backlog.length > 200) backlog = backlog.slice(-200);
}

function pushState(state, source, fetchedMs) {
  if (!state?.you) return;
  rememberSeat(state);
  rememberEvents(state.events);
  if (state.t < latestT) {
    // Older than what the page already has: forward only its events.
    if (state.events?.length) broadcast({ type: 'events', events: state.events, source });
    return;
  }
  latest = state;
  latestT = state.t;
  broadcast({ type: 'state', state, source, ms: fetchedMs, sent: Date.now() });
}

let lastCursor = null;
let refreshing = null;
let refreshAgain = false;

// Coalesced perceive: at most one in flight, one queued.
function refresh(source = 'refresh') {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      const t0 = performance.now();
      const args = { events: 50 };
      if (lastCursor != null) args.cursor = lastCursor;
      const out = await main.call('perceive', args).catch((e) => ({ error: e.message }));
      if (out?.result) {
        if (out.result.cursor != null) lastCursor = out.result.cursor;
        pushState(out.result, source, Math.round(performance.now() - t0));
      } else if (out?.error) {
        broadcast({ type: 'error', error: String(out.error) });
      }
    } while (refreshAgain);
    refreshing = null;
  })();
  return refreshing;
}

// Watcher loop: the server holds this call open until something touches us.
async function watchLoop() {
  for (;;) {
    const t0 = performance.now();
    try {
      const out = await watcher.call('wait', { timeout: 30, full: true });
      const ms = Math.round(performance.now() - t0);
      const r = out?.result;
      if (r?.you) pushState(r, 'wait', ms);
      else if (r?.events?.length) { rememberEvents(r.events); broadcast({ type: 'events', events: r.events, source: 'wait' }); refresh('wait'); }
      else if (out?.error) { broadcast({ type: 'error', error: String(out.error) }); await sleep(1000); }
      else if (r?.ok === false) { broadcast({ type: 'error', error: String(r.reason || 'refused') }); await sleep(3000); }
    } catch (e) {
      console.error('[watch]', e.message);
      await sleep(1000);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP
const ALLOWED = new Set(['act', 'say', 'inspect', 'history', 'perceive', 'intend', 'recall', 'summary']);
const MUTATING = new Set(['act', 'say', 'intend']);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'index.html')));
    }

    // the client's own scripts and images, by plain file name only
    const asset = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]*\.(js|css|png|jpg|svg))$/i);
    if (req.method === 'GET' && asset) {
      const file = path.join(HERE, 'public', asset[1]);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      const types = { js: 'text/javascript', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${types[asset[2].toLowerCase()]}; charset=utf-8`, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.socket.setNoDelay(true);
      res.write('retry: 500\n\n');
      // State first so the page knows everyone's names before the backlog arrives.
      if (latest) res.write(`data: ${JSON.stringify({ type: 'state', state: { ...latest, events: [] }, source: 'cache', sent: Date.now() })}\n\n`);
      if (backlog.length) res.write(`data: ${JSON.stringify({ type: 'events', events: backlog, source: 'backlog' })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      refresh('open');
      return;
    }

    const m = url.pathname.match(/^\/api\/([a-z_]+)$/);
    if (req.method === 'POST' && m) {
      const tool = m[1];
      if (!ALLOWED.has(tool)) return sendJson(res, 403, { error: `"${tool}" is not exposed by the viewer` });
      const args = await readJson(req);
      const t0 = performance.now();
      const out = await main.call(tool, args);
      const ms = Math.round(performance.now() - t0);
      if (out?.result?.events) rememberEvents(out.result.events);
      sendJson(res, 200, { ...out, ms });
      if (MUTATING.has(tool)) refresh(tool);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[${url.pathname}]`, e.message);
    sendJson(res, 502, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Embody Viewer → http://localhost:${PORT}`);
  console.log(`Relaying to ${new URL(config.url).host}`);
  try {
    await Promise.all([main.ensure(), watcher.ensure()]);
    // Seed the log with recent history, then the first perception.
    const first = await main.call('perceive', { events: 0 });
    const cursor = first?.result?.cursor;
    if (cursor != null) {
      lastCursor = cursor;
      // history pages forward from `since`, so look back far and keep the tail.
      const hist = await main.call('history', { since: Math.max(0, cursor - 5000), limit: 500 });
      if (Array.isArray(hist?.result)) rememberEvents(hist.result.slice(-120));
    }
    if (first?.result) pushState(first.result, 'start', 0);
    watchLoop();
    // wait() only wakes for events that touch you; a slow heartbeat keeps
    // ambient drift (time of day, thirst) fresh while a page is open.
    setInterval(() => { if (clients.size) refresh('heartbeat'); }, 15000);
  } catch (e) {
    console.error('Could not reach the Embody server:', e.message);
  }
});
