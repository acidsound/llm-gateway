import http from 'node:http';
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

const upstreams = config.upstreams.map((u) => ({ ...u, pool: new KeyPool(u.keys) }));
const routeStore = new RouteStore({
  upstreams,
  initialRoutes: config.routes,
  file: config.routesFile,
  logger,
});
const proxy = new UpstreamProxy({
  upstreams,
  routes: routeStore.routes,
  logger,
  timeoutMs: config.requestTimeoutMs,
});

logger.info(
  `Loaded ${upstreams.length} upstream(s): ` +
    upstreams.map((u) => `${u.name} (${u.pool.keys.length} keys, ${u.models.length} models)`).join(', ')
);
logger.info(`Routes: ${proxy.availableModels().join(', ')}`);
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
    if (req.method === 'GET' && pathname === '/health') {
      handleHealth(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/stats') {
      handleStats(req, reqUrl, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/models') {
      // Synthesize the model catalog from routes — callers see exactly what they can use.
      const models = proxy.availableModels();
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(
        JSON.stringify({
          object: 'list',
          data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'proxy' })),
        })
      );
      return;
    }
    if (pathname.startsWith('/v1/')) {
      await proxy.handle(req, res);
      logger.info(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - start}ms)`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${pathname}`, type: 'not_found', code: 404 } }));
  } catch (err) {
    const status = err.statusCode || 500;
    logger.error(`request ${req.method} ${pathname} failed: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error', code: status } }));
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
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'unauthorized', code: 401 } }));
    return;
  }
  const body = {
    now: new Date().toISOString(),
    availableModels: proxy.availableModels(),
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error(`unhandled rejection: ${err?.stack || err}`);
});
