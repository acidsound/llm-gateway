import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from './lib/common.js';
import { loadConfig } from './lib/config.js';
import { KeyPool } from './lib/keys.js';
import { RouteStore } from './lib/routes.js';
import { UpstreamProxy } from './lib/upstream.js';
import { handleAdmin, isAuthorized } from './lib/admin.js';
import { createLogger } from './lib/logger.js';

if (typeof fetch !== 'function') {
  console.error(`This proxy requires Node.js >= 18.17 (global fetch). Current version: ${process.version}`);
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger(process.env.LOG_LEVEL || 'info');

const upstreams = config.upstreams.map((u) => ({ ...u, pool: new KeyPool(u.keys, { sticky: u.sticky }) }));

// Restore key health (disabled keys) from the previous run.
{
  const healthFile = config.keyHealthFile;
  if (fs.existsSync(healthFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      let restored = 0;
      for (const u of upstreams) {
        const entries = saved[u.name];
        if (entries) restored += u.pool.importHealth(entries);
      }
      if (restored > 0) logger.info(`Restored ${restored} disabled key(s) from ${healthFile}`);
    } catch (err) {
      logger.warn(`Failed to restore key health from ${healthFile}: ${err.message}`);
    }
  }
}

const routeStore = new RouteStore({
  upstreams,
  initialRoutes: config.routes,
  file: config.routesFile,
  logger,
});
const proxy = new UpstreamProxy({
  upstreams,
  // Pass the RouteStore instance (not just the raw map) so the proxy can
  // record per-model usage for recency-ordered /v1/models catalogs.
  routes: routeStore,
  logger,
  timeoutMs: config.requestTimeoutMs,
});

logger.info(
  `Loaded ${upstreams.length} upstream(s): ` +
    upstreams.map((u) => `${u.name} (${u.pool.keys.length} keys, ${u.models.length} models)`).join(', ')
);
logger.info(`Routes: ${routeStore.availableModels().join(', ')}`);
logger.info(`Config file: ${config.configPath}`);
logger.info(`Runtime routes file: ${config.routesFile}`);
if (!config.adminToken) {
  logger.warn('ADMIN_TOKEN is not set - /admin/* and /stats endpoints are unauthenticated');
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://proxy.local');
  const pathname = reqUrl.pathname;
  const start = Date.now();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, Accept',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  try {
    if (pathname.startsWith('/admin/')) {
      if (await handleAdmin(req, res, reqUrl, { store: routeStore, adminToken: config.adminToken, logger })) {
        return;
      }
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      handleHealth(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/stats') {
      handleStats(req, reqUrl, res);
      return;
    }
    if (req.method === 'GET' && (pathname === '/v1' || pathname === '/v1/')) {
      sendJson(res, 200, {
        status: 'ok',
        message: 'llm-gateway is running',
        availableModels: routeStore.availableModels(),
      });
      return;
    }
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/v1/models/' || pathname === '/models')) {
      // Synthesize the model catalog from routes — callers see exactly what they can use.
      // owned_by reflects the upstream(s) behind each route (primary + distinct fallbacks).
      sendJson(res, 200, { object: 'list', data: routeStore.catalog() });
      return;
    }
    if (req.method === 'GET') {
      // GET /v1/models/{model} (and /models/{model}) — OpenAI single-model retrieval.
      // Without this the /{model} sub-path falls through to the proxy, which treats the
      // request as a chat/completions call and demands `model` in the body (400).
      const modelMatch = pathname.match(/^\/v1\/models\/([^/]+)$/) || pathname.match(/^\/models\/([^/]+)$/);
      if (modelMatch) {
        let modelId = modelMatch[1];
        try { modelId = decodeURIComponent(modelId); } catch { /* keep raw on malformed encoding */ }
        const entry = routeStore.catalog().find((e) => e.id === modelId);
        if (entry) {
          sendJson(res, 200, entry);
          return;
        }
        // A glob route key (e.g. "llama-*") can serve models the caller didn't name verbatim.
        const key = routeStore.routeKeyFor(modelId);
        if (key) {
          const base = routeStore.catalog().find((e) => e.id === key);
          sendJson(res, 200, { object: 'model', id: modelId, created: 0, owned_by: base ? base.owned_by : 'proxy' });
          return;
        }
        sendJson(res, 404, { error: { message: `Model not found: ${modelId}`, type: 'invalid_request_error', code: 404 } });
        return;
      }
    }
    if (pathname.startsWith('/v1/')) {
      await proxy.handle(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: `Not found: ${pathname}`, type: 'not_found', code: 404 } });
  } catch (err) {
    const status = err.statusCode || 500;
    logger.error(`request ${req.method} ${pathname} failed: ${err.stack || err.message}`);
    if (!res.headersSent) {
      sendJson(res, status, { error: { message: err.message, type: 'proxy_error', code: status } });
    } else {
      res.destroy();
    }
  }
});

function handleHealth(res) {
  const ups = upstreams.map((u) => {
    const st = u.pool.status();
    const ready = st.filter((s) => s.state === 'ready').length;
    return { name: u.name, state: ready > 0 ? 'ok' : 'degraded', readyKeys: ready, totalKeys: st.length, keys: st };
  });
  const totalReady = ups.reduce((s, u) => s + u.readyKeys, 0);
  const totalKeys = ups.reduce((s, u) => s + u.totalKeys, 0);
  const body = {
    status: totalReady > 0 ? 'ok' : 'degraded',
    readyKeys: totalReady,
    totalKeys,
    upstreams: ups,
  };
  res.writeHead(totalReady > 0 ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function handleStats(req, reqUrl, res) {
  if (!isAuthorized(req, reqUrl)) {
    sendJson(res, 401, { error: { message: 'Unauthorized', type: 'unauthorized', code: 401 } });
    return;
  }
  const body = {
    now: new Date().toISOString(),
    availableModels: routeStore.availableModels(),
    routes: routeStore.list(),
    upstreams: upstreams.map((u) => ({
      name: u.name,
      baseUrl: u.baseUrl,
      models: u.models,
      keys: u.pool.status(),
    })),
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

server.listen(config.port, () => {
  logger.info(`llm-gateway listening on http://0.0.0.0:${config.port}`);
  logger.info(`OpenAI-compatible base URL for your backend: http://localhost:${config.port}/v1`);
});

function shutdown(signal) {
  logger.info(`received ${signal}, shutting down`);
  // Persist key health so disabled keys stay dead across restarts.
  try {
    const out = {};
    for (const u of upstreams) out[u.name] = u.pool.exportHealth();
    const tmp = `${config.keyHealthFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    fs.renameSync(tmp, config.keyHealthFile);
  } catch (err) {
    logger.warn(`Failed to persist key health: ${err.message}`);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error(`unhandled rejection: ${err?.stack || err}`);
});
