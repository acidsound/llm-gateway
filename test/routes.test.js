import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { RouteStore } from '../lib/routes.js';
import { handleAdmin } from '../lib/admin.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('error');

const UPSTREAMS = [
  { name: 'cerebras', baseUrl: 'https://x/v1', models: [], keys: [] },
  { name: 'groq', baseUrl: 'https://y/v1', models: [], keys: [] },
];

test('RouteStore: set/get/delete/list', () => {
  const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, logger });
  store.set('chat-fast', 'cerebras/gemma-4-31b');
  assert.equal(store.get('chat-fast').upstream, 'cerebras');
  assert.equal(store.get('chat-fast').model, 'gemma-4-31b');

  store.set('chat-2', {
    upstream: 'groq',
    model: 'llama-3.3-70b-versatile',
    fallbacks: ['cerebras/gpt-oss-120b'],
  });
  assert.equal(store.get('chat-2').fallbacks[0].upstream, 'cerebras');
  assert.deepEqual(store.availableModels(), ['chat-2', 'chat-fast']);

  assert.equal(store.delete('chat-fast'), true);
  assert.equal(store.get('chat-fast'), undefined);
  assert.equal(store.delete('chat-fast'), false);
});

test('RouteStore: rejects unknown upstreams', () => {
  const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, logger });
  assert.throws(() => store.set('x', { upstream: 'nope', model: 'm' }), /unknown upstream/);
});

test('RouteStore: catalog reflects upstream names', () => {
  const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, logger });
  store.set('model-a', { upstream: 'cerebras', model: 'gemma-4-31b' });
  store.set('model-b', {
    upstream: 'cerebras',
    model: 'gpt-oss-120b',
    fallbacks: [{ upstream: 'groq', model: 'llama-3.3-70b-versatile' }],
  });
  store.set('model-c', {
    upstream: 'groq',
    model: 'llama-3.3-70b-versatile',
    fallbacks: [
      { upstream: 'groq', model: 'other-model' },   // same upstream deduped
      { upstream: 'cerebras', model: 'gemma-4-31b' },
    ],
  });

  const cat = store.catalog();
  assert.equal(cat.length, 3);
  assert.equal(cat[0].id, 'model-a');
  assert.equal(cat[0].owned_by, 'cerebras');
  assert.equal(cat[1].id, 'model-b');
  assert.equal(cat[1].owned_by, 'cerebras, groq');
  assert.equal(cat[2].id, 'model-c');
  assert.equal(cat[2].owned_by, 'groq, cerebras');
  // Standard OpenAI shape
  for (const entry of cat) {
    assert.equal(entry.object, 'model');
    assert.equal(entry.created, 0);
  }
});

test('RouteStore: persists and reloads routes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const file = path.join(dir, 'routes.json');
  try {
    const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, file, logger });
    store.set('runtime-route', { upstream: 'groq', model: 'llama-3.3-70b-versatile' });
    await store.persist();
    assert.ok(fs.existsSync(file));

    const reloaded = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, file, logger });
    assert.equal(reloaded.get('runtime-route').upstream, 'groq');
    assert.equal(reloaded.get('runtime-route').model, 'llama-3.3-70b-versatile');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RouteStore: persisted routes override config routes with the same name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const file = path.join(dir, 'routes.json');
  try {
    const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, file, logger });
    store.set('dup', { upstream: 'cerebras', model: 'gemma-4-31b' });
    await store.persist();

    const reloaded = new RouteStore(
      { upstreams: UPSTREAMS, initialRoutes: { dup: { upstream: 'groq', model: 'llama-3.3-70b-versatile' } }, file, logger }
    );
    assert.equal(reloaded.get('dup').upstream, 'cerebras', 'persisted file should win over config');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RouteStore: persists only the diff against the config baseline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const file = path.join(dir, 'routes.json');
  try {
    const baseline = { auto: { upstream: 'cerebras', model: 'gemma-4-31b', fallback: null } };
    const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: baseline, file, logger });
    store.set('added', { upstream: 'groq', model: 'llama-3.3-70b-versatile' });
    await store.persist();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!('auto' in saved), 'unchanged baseline routes should not be persisted');
    assert.equal(saved.added.upstream, 'groq');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RouteStore: deleting a config route persists a tombstone that survives reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const file = path.join(dir, 'routes.json');
  try {
    const baseline = { auto: { upstream: 'cerebras', model: 'gemma-4-31b', fallback: null } };
    const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: baseline, file, logger });
    assert.equal(store.delete('auto'), true);
    await store.persist();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.auto, null, 'deleted baseline route should be a tombstone');

    const reloaded = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: baseline, file, logger });
    assert.equal(reloaded.get('auto'), undefined, 'deletion should survive restart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RouteStore: skips invalid persisted entries without failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const file = path.join(dir, 'routes.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ good: 'cerebras/gemma-4-31b', bad: 'nope/x' }));
    const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, file, logger });
    assert.equal(store.get('good').upstream, 'cerebras');
    assert.equal(store.get('bad'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- admin API (HTTP) ----

function startAdminServer(store, adminToken) {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://x');
    const handled = await handleAdmin(req, res, reqUrl, { store, adminToken, logger });
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  );
}

async function adminReq(port, method, pathname, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('admin API: GET/PUT/DELETE routes with auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const file = path.join(dir, 'routes.json');
  const store = new RouteStore({ upstreams: UPSTREAMS, initialRoutes: {}, file, logger });
  const { server, port } = await startAdminServer(store, 's3cret');
  try {
    assert.equal((await adminReq(port, 'GET', '/admin/routes')).status, 401, 'no token -> 401');
    assert.equal((await adminReq(port, 'GET', '/admin/routes', undefined, 'wrong')).status, 401);

    let r = await adminReq(port, 'PUT', '/admin/routes/chat-fast', { upstream: 'cerebras', model: 'gemma-4-31b' }, 's3cret');
    assert.equal(r.status, 200);
    assert.equal(store.get('chat-fast').model, 'gemma-4-31b');
    assert.ok(fs.existsSync(file), 'route should be persisted');

    r = await adminReq(port, 'PUT', '/admin/routes/bad', { upstream: 'nope', model: 'm' }, 's3cret');
    assert.equal(r.status, 400, 'unknown upstream -> 400');

    r = await adminReq(port, 'PUT', '/admin/routes/chat-2', 'groq/llama-3.3-70b-versatile', 's3cret');
    assert.equal(r.status, 200);
    assert.equal(store.get('chat-2').upstream, 'groq');

    r = await adminReq(port, 'GET', '/admin/routes', undefined, 's3cret');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.routes).sort(), ['chat-2', 'chat-fast']);
    assert.deepEqual(r.json.models, ['chat-2', 'chat-fast']);

    r = await adminReq(port, 'DELETE', '/admin/routes/chat-fast', undefined, 's3cret');
    assert.equal(r.status, 200);
    assert.equal(store.get('chat-fast'), undefined);
    r = await adminReq(port, 'DELETE', '/admin/routes/chat-fast', undefined, 's3cret');
    assert.equal(r.status, 404, 'deleting a missing route -> 404');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
