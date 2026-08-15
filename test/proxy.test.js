import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { KeyPool } from '../lib/keys.js';
import { UpstreamProxy } from '../lib/upstream.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('error');

/** Fake upstream that rate-limits specific auth tokens / models and rejects specific models. */
function startFakeUpstream({ badAuth = new Set(), invalidAuth = new Set(), rejectModels = new Set(), modelBadAuth = new Map(), serverErrorAuth = new Set() } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || '';
      const parsed = body.length ? safeJson(body) : null;
      calls.push({ method: req.method, path: req.url, auth, body: parsed });

      if (parsed && rejectModels.has(parsed.model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown model', type: 'invalid_request_error' } }));
        return;
      }
      if (invalidAuth.has(auth)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }));
        return;
      }
      if (parsed && modelBadAuth.get(auth) === parsed.model) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }));
        return;
      }
      if (badAuth.has(auth)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }));
        return;
      }
      if (serverErrorAuth.has(auth)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream overloaded', type: 'server_error' } }));
        return;
      }
      if (parsed && parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"cmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        })
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }))
  );
}

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

const DEFAULT_MODELS = ['llama-3.3-70b', 'gemma-4-31b', 'gpt-oss-120b'];

function makeProxyServer(upstreams, routes) {
  const proxy = new UpstreamProxy({ upstreams, routes, logger, timeoutMs: 5000 });
  const server = http.createServer((req, res) =>
    proxy.handle(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    })
  );
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, proxy }))
  );
}

/** Single-upstream helper with identity routes for the given models (plus extra routes). */
function startProxy(pool, upstreamBaseUrl, { models = DEFAULT_MODELS, routes = {} } = {}) {
  const upstreams = [{ name: 'up1', baseUrl: upstreamBaseUrl, pool }];
  const allRoutes = { ...routes };
  for (const m of models) if (!allRoutes[m]) allRoutes[m] = { upstream: 'up1', model: m };
  return makeProxyServer(upstreams, allRoutes);
}

async function post(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const TWO_KEYS = () => [
  { name: 'bad', apiKey: 'csk-BAD', rpm: 10, tpm: 10_000 },
  { name: 'good', apiKey: 'csk-GOOD', rpm: 10, tpm: 10_000 },
];

test('rotates to a healthy key when the first key is rate limited', async () => {
  const fake = await startFakeUpstream({ badAuth: new Set(['Bearer csk-BAD']) });
  const pool = new KeyPool(TWO_KEYS());
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`);
  try {
    const r = await post(proxy.port, '/v1/chat/completions', {
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).choices[0].message.content, 'ok');
    assert.deepEqual(fake.calls.map((c) => c.auth), ['Bearer csk-BAD', 'Bearer csk-GOOD']);
    const badRec = pool.keys[0].models.get('llama-3.3-70b');
    assert.ok(badRec && badRec.cooldownUntil > Date.now(), 'bad key should be cooling down for this model');
    assert.equal(pool.keys[1].cooldownUntil, 0, 'good key should stay ready (no global cooldown)');
    assert.equal(r.headers.get('x-proxy-key'), 'up1/good');
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('streams SSE responses through using the next available key', async () => {
  const fake = await startFakeUpstream({ badAuth: new Set(['Bearer csk-BAD']) });
  const pool = new KeyPool(TWO_KEYS());
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`);
  try {
    const r = await post(
      proxy.port,
      '/v1/chat/completions',
      { model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { accept: 'text/event-stream' }
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    assert.match(r.text, /data: \[DONE\]/);
    assert.deepEqual(fake.calls.map((c) => c.auth), ['Bearer csk-BAD', 'Bearer csk-GOOD']);
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('returns 429 with Retry-After when every key is rate limited', async () => {
  const fake = await startFakeUpstream({ badAuth: new Set(['Bearer csk-BAD', 'Bearer csk-WORSE']) });
  const pool = new KeyPool([
    { name: 'bad', apiKey: 'csk-BAD', rpm: 10, tpm: 10_000 },
    { name: 'worse', apiKey: 'csk-WORSE', rpm: 10, tpm: 10_000 },
  ]);
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`);
  try {
    const r = await post(proxy.port, '/v1/chat/completions', {
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'), 'should include Retry-After');
    assert.ok(JSON.parse(r.text).error.code === 429);
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('does not rotate on client errors (400) and marks no key as failed', async () => {
  const fake = await startFakeUpstream({ rejectModels: new Set(['bad-model']) });
  const pool = new KeyPool(TWO_KEYS());
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`, { models: ['bad-model'] });
  try {
    const r = await post(proxy.port, '/v1/chat/completions', {
      model: 'bad-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 400);
    assert.equal(fake.calls.length, 1, 'only one key should be tried');
    assert.equal(pool.keys[0].consecutiveFailures, 0);
    assert.equal(pool.keys[0].cooldownUntil, 0);
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('a 429 on one model does not cool the key for other models', async () => {
  const fake = await startFakeUpstream({ modelBadAuth: new Map([['Bearer csk-BAD', 'gemma-4-31b']]) });
  const pool = new KeyPool(TWO_KEYS());
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`);
  try {
    const r1 = await post(proxy.port, '/v1/chat/completions', {
      model: 'gemma-4-31b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(fake.calls.map((c) => c.auth), ['Bearer csk-BAD', 'Bearer csk-GOOD']);
    assert.ok(pool.keys[0].models.get('gemma-4-31b').cooldownUntil > Date.now());

    const r2 = await post(proxy.port, '/v1/chat/completions', {
      model: 'gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r2.status, 200);
    assert.equal(fake.calls[2].auth, 'Bearer csk-BAD', 'BAD key should serve other models while gemma cools down');
    assert.equal(pool.keys[0].models.get('gpt-oss-120b').cooldownUntil, 0);
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('a 5xx cools down the whole key for all models', async () => {
  const fake = await startFakeUpstream({ serverErrorAuth: new Set(['Bearer csk-BAD']) });
  const pool = new KeyPool(TWO_KEYS());
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`);
  try {
    const r1 = await post(proxy.port, '/v1/chat/completions', {
      model: 'gemma-4-31b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r1.status, 200);
    assert.ok(pool.keys[0].cooldownUntil > Date.now(), 'whole key should be in global cooldown after 5xx');

    const r2 = await post(proxy.port, '/v1/chat/completions', {
      model: 'gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r2.status, 200);
    assert.equal(fake.calls[2].auth, 'Bearer csk-GOOD');
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('routes by model name to the right upstream', async () => {
  const fakeA = await startFakeUpstream();
  const fakeB = await startFakeUpstream();
  const poolA = new KeyPool([{ name: 'k1', apiKey: 'csk-A', rpm: 10, tpm: 10_000 }]);
  const poolB = new KeyPool([{ name: 'k1', apiKey: 'gsk-B', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [
      { name: 'cerebras', baseUrl: `http://127.0.0.1:${fakeA.port}/v1`, pool: poolA },
      { name: 'groq', baseUrl: `http://127.0.0.1:${fakeB.port}/v1`, pool: poolB },
    ],
    {
      'gemma-4-31b': { upstream: 'cerebras', model: 'gemma-4-31b' },
      'llama-3.3-70b-versatile': { upstream: 'groq', model: 'llama-3.3-70b-versatile' },
    }
  );
  try {
    await post(proxy.port, '/v1/chat/completions', { model: 'gemma-4-31b', messages: [] });
    await post(proxy.port, '/v1/chat/completions', { model: 'llama-3.3-70b-versatile', messages: [] });
    assert.equal(fakeA.calls.length, 1);
    assert.equal(fakeB.calls.length, 1);
    assert.equal(fakeA.calls[0].auth, 'Bearer csk-A');
    assert.equal(fakeB.calls[0].auth, 'Bearer gsk-B');
    assert.equal(fakeA.calls[0].body.model, 'gemma-4-31b');
    assert.equal(fakeB.calls[0].body.model, 'llama-3.3-70b-versatile');
  } finally {
    proxy.server.close();
    fakeA.server.close();
    fakeB.server.close();
  }
});

test('rewrites the caller model to the provider model via a route alias', async () => {
  const fake = await startFakeUpstream();
  const pool = new KeyPool([{ name: 'k1', apiKey: 'csk-A', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [{ name: 'cerebras', baseUrl: `http://127.0.0.1:${fake.port}/v1`, pool }],
    { 'chat-fast': { upstream: 'cerebras', model: 'gemma-4-31b' } }
  );
  try {
    const r = await post(proxy.port, '/v1/chat/completions', { model: 'chat-fast', messages: [] });
    assert.equal(r.status, 200);
    assert.equal(fake.calls[0].body.model, 'gemma-4-31b');
    // rate-limit tracking uses the provider model id
    assert.ok(pool.keys[0].models.get('gemma-4-31b'));
    assert.equal(r.headers.get('x-proxy-key'), 'cerebras/k1');
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('rejects unknown models with 400 without contacting any upstream', async () => {
  const fake = await startFakeUpstream();
  const pool = new KeyPool([{ name: 'k1', apiKey: 'csk-A', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [{ name: 'cerebras', baseUrl: `http://127.0.0.1:${fake.port}/v1`, pool }],
    { 'gemma-4-31b': { upstream: 'cerebras', model: 'gemma-4-31b' } }
  );
  try {
    const r = await post(proxy.port, '/v1/chat/completions', { model: 'no-such-model', messages: [] });
    assert.equal(r.status, 400);
    assert.match(r.text, /gemma-4-31b/);
    assert.equal(fake.calls.length, 0, 'no upstream call for an unroutable model');
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('falls back to another provider when the primary provider is exhausted', async () => {
  const fakeA = await startFakeUpstream({ badAuth: new Set(['Bearer csk-A1', 'Bearer csk-A2']) });
  const fakeB = await startFakeUpstream();
  const poolA = new KeyPool([
    { name: 'a1', apiKey: 'csk-A1', rpm: 10, tpm: 10_000 },
    { name: 'a2', apiKey: 'csk-A2', rpm: 10, tpm: 10_000 },
  ]);
  const poolB = new KeyPool([{ name: 'b1', apiKey: 'gsk-B', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [
      { name: 'cerebras', baseUrl: `http://127.0.0.1:${fakeA.port}/v1`, pool: poolA },
      { name: 'groq', baseUrl: `http://127.0.0.1:${fakeB.port}/v1`, pool: poolB },
    ],
    {
      chat: {
        upstream: 'cerebras',
        model: 'gemma-4-31b',
        fallbacks: [{ upstream: 'groq', model: 'llama-3.3-70b-versatile' }],
      },
    }
  );
  try {
    const r = await post(proxy.port, '/v1/chat/completions', { model: 'chat', messages: [] });
    assert.equal(r.status, 200);
    assert.equal(fakeA.calls.length, 2, 'both primary keys should have been tried');
    assert.equal(fakeB.calls.length, 1, 'fallback provider should serve');
    assert.equal(fakeB.calls[0].body.model, 'llama-3.3-70b-versatile');
    assert.equal(r.headers.get('x-proxy-key'), 'groq/b1');
  } finally {
    proxy.server.close();
    fakeA.server.close();
    fakeB.server.close();
  }
});

test('availableModels returns the routed model catalog', async () => {
  const fake = await startFakeUpstream();
  const pool = new KeyPool([{ name: 'k1', apiKey: 'csk-A', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [{ name: 'cerebras', baseUrl: `http://127.0.0.1:${fake.port}/v1`, pool }],
    {
      'gemma-4-31b': { upstream: 'cerebras', model: 'gemma-4-31b' },
      'chat-fast': { upstream: 'cerebras', model: 'gemma-4-31b' },
    }
  );
  try {
    assert.deepEqual(proxy.proxy.availableModels(), ['chat-fast', 'gemma-4-31b']);
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('stops retrying after a 401 and disables the invalid key', async () => {
  const fake = await startFakeUpstream({ invalidAuth: new Set(['Bearer csk-BAD', 'Bearer csk-BAD2']) });
  const pool = new KeyPool([
    { name: 'bad1', apiKey: 'csk-BAD', rpm: 10, tpm: 10_000 },
    { name: 'bad2', apiKey: 'csk-BAD2', rpm: 10, tpm: 10_000 },
  ]);
  const proxy = await startProxy(pool, `http://127.0.0.1:${fake.port}/v1`);
  try {
    const r = await post(proxy.port, '/v1/chat/completions', {
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 503); // no usable keys left after both were invalidated
    assert.equal(fake.calls.length, 2);
    assert.ok(pool.keys[0].disabled);
    assert.ok(pool.keys[1].disabled);
    const r2 = await post(proxy.port, '/v1/chat/completions', {
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r2.status, 503);
    assert.equal(fake.calls.length, 2);
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('glob route patterns match model names with wildcards', async () => {
  const { RouteStore } = await import('../lib/routes.js');
  const fake = await startFakeUpstream();
  const pool = new KeyPool([{ name: 'k1', apiKey: 'csk-A', rpm: 10, tpm: 10_000 }]);
  const upstreams = [{ name: 'up1', baseUrl: `http://127.0.0.1:${fake.port}/v1`, pool }];
  const store = new RouteStore({
    upstreams,
    initialRoutes: {
      'llama-*': { upstream: 'up1', model: 'llama-3.3-70b', fallbacks: [] },
      'exact-model': { upstream: 'up1', model: 'gemma-4-31b', fallbacks: [] },
    },
    logger,
  });
  const proxy = new UpstreamProxy({ upstreams, routes: store, logger, timeoutMs: 5000 });
  const server = http.createServer((req, res) => proxy.handle(req, res).catch(() => { res.writeHead(500); res.end('err'); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    // Exact match takes priority
    const r1 = await post(server.address().port, '/v1/chat/completions', { model: 'exact-model', messages: [] });
    assert.equal(r1.status, 200);
    assert.equal(fake.calls[0].body.model, 'gemma-4-31b');

    // Glob match
    const r2 = await post(server.address().port, '/v1/chat/completions', { model: 'llama-3.1-8b-instant', messages: [] });
    assert.equal(r2.status, 200);
    assert.equal(fake.calls[1].body.model, 'llama-3.3-70b', 'glob should rewrite to the route target model');

    // No match
    const r3 = await post(server.address().port, '/v1/chat/completions', { model: 'gpt-4', messages: [] });
    assert.equal(r3.status, 400);
  } finally {
    server.close();
    fake.server.close();
  }
});

test('fallback chain tries targets in order', async () => {
  const fakeA = await startFakeUpstream({ badAuth: new Set(['Bearer csk-A1']) });
  const fakeB = await startFakeUpstream({ badAuth: new Set(['Bearer csk-B1']) });
  const fakeC = await startFakeUpstream();
  const poolA = new KeyPool([{ name: 'a1', apiKey: 'csk-A1', rpm: 10, tpm: 10_000 }]);
  const poolB = new KeyPool([{ name: 'b1', apiKey: 'csk-B1', rpm: 10, tpm: 10_000 }]);
  const poolC = new KeyPool([{ name: 'c1', apiKey: 'csk-C1', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [
      { name: 'upA', baseUrl: `http://127.0.0.1:${fakeA.port}/v1`, pool: poolA },
      { name: 'upB', baseUrl: `http://127.0.0.1:${fakeB.port}/v1`, pool: poolB },
      { name: 'upC', baseUrl: `http://127.0.0.1:${fakeC.port}/v1`, pool: poolC },
    ],
    {
      chat: {
        upstream: 'upA',
        model: 'gemma-4-31b',
        fallbacks: [
          { upstream: 'upB', model: 'llama-3.3-70b-versatile' },
          { upstream: 'upC', model: 'gpt-oss-120b' },
        ],
      },
    }
  );
  try {
    const r = await post(proxy.port, '/v1/chat/completions', { model: 'chat', messages: [] });
    assert.equal(r.status, 200);
    assert.equal(fakeA.calls.length, 1, 'primary tried once');
    assert.equal(fakeB.calls.length, 1, 'first fallback tried once');
    assert.equal(fakeC.calls.length, 1, 'second fallback serves');
    assert.equal(fakeC.calls[0].body.model, 'gpt-oss-120b');
    assert.equal(r.headers.get('x-proxy-key'), 'upC/c1');
  } finally {
    proxy.server.close();
    fakeA.server.close();
    fakeB.server.close();
    fakeC.server.close();
  }
});

test('anthropic adapter uses x-api-key auth', async () => {
  const fake = await startFakeUpstream();
  const pool = new KeyPool([{ name: 'k1', apiKey: 'sk-ant-TEST', rpm: 10, tpm: 10_000 }]);
  const proxy = await makeProxyServer(
    [{ name: 'anthropic', baseUrl: `http://127.0.0.1:${fake.port}`, adapter: { auth: 'x-api-key', pathPrefix: '/v1', extraHeaders: { 'anthropic-version': '2023-06-01' } }, pool }],
    { 'claude-3': { upstream: 'anthropic', model: 'claude-3-sonnet', fallbacks: [] } }
  );
  try {
    const r = await post(proxy.port, '/v1/chat/completions', { model: 'claude-3', messages: [] });
    assert.equal(r.status, 200);
    // The fake upstream records the authorization header; with x-api-key auth
    // the key goes in x-api-key instead.
    assert.equal(fake.calls[0].auth, '', 'no authorization header for x-api-key auth');
  } finally {
    proxy.server.close();
    fake.server.close();
  }
});

test('key health export/import preserves disabled state', async () => {
  const pool = new KeyPool([
    { name: 'good', apiKey: 'k1', rpm: 10, tpm: 10_000 },
    { name: 'bad', apiKey: 'k2', rpm: 10, tpm: 10_000 },
  ]);
  pool.markInvalid(pool.keys[1], 'test disable');
  const snapshot = pool.exportHealth();
  assert.equal(snapshot[1].disabled, true);

  const pool2 = new KeyPool([
    { name: 'good', apiKey: 'k1', rpm: 10, tpm: 10_000 },
    { name: 'bad', apiKey: 'k2', rpm: 10, tpm: 10_000 },
  ]);
  const restored = pool2.importHealth(snapshot);
  assert.equal(restored, 1);
  assert.ok(pool2.keys[1].disabled);
  assert.equal(pool2.keys[1].disabledReason, 'test disable');
  assert.ok(!pool2.keys[0].disabled);
});
