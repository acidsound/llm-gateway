import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAdapter } from './adapters.js';

const DEFAULT_RPM = 30;
const DEFAULT_TPM = 30_000;

/**
 * Loads and normalizes configuration.
 *
 * New format:
 *   {
 *     "upstreams": [{ "name", "baseUrl", "adapter"?, "models": [...], "keys": [...], "rateLimitHeaders"? }],
 *     "routes": { "caller-model": "provider/model" | { "upstream", "model", "fallbacks"? } }
 *   }
 * Routes for models listed in upstreams[].models are auto-created (identity mapping)
 * unless an explicit route overrides them.
 *
 * Legacy flat format (still supported):
 *   { "upstreamBaseUrl", "keys": [...] }  -> single upstream named "default"
 */
export function loadConfig() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json');

  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse config file ${configPath}: ${err.message}`);
    }
  }

  const port = Number(process.env.PORT || fileConfig.port || 8787);
  const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || fileConfig.requestTimeoutMs || 300_000);
  const adminToken = process.env.ADMIN_TOKEN || fileConfig.adminToken || null;
  const routesFile = process.env.ROUTES_FILE || fileConfig.routesFile || path.join(__dirname, '..', 'routes.json');
  const keyHealthFile =
    process.env.KEY_HEALTH_FILE || fileConfig.keyHealthFile || path.join(__dirname, '..', 'key-health.json');

  let upstreams;
  if (Array.isArray(fileConfig.upstreams) && fileConfig.upstreams.length > 0) {
    upstreams = fileConfig.upstreams.map(normalizeUpstream);
  } else {
    // Legacy: single upstream from flat keys + upstreamBaseUrl
    const baseUrl = String(
      process.env.UPSTREAM_BASE_URL || fileConfig.upstreamBaseUrl || 'https://api.cerebras.ai/v1'
    ).replace(/\/+$/, '');
    const keys = legacyKeys(fileConfig);
    if (keys.length === 0) {
      throw new Error(
        'No API keys configured. Provide upstreams[].keys in config.json or UPSTREAM_KEYS env var.'
      );
    }
    upstreams = [
      normalizeUpstream({ name: fileConfig.upstreamName || 'default', baseUrl, models: fileConfig.models, keys }),
    ];
  }

  const names = new Set();
  for (const u of upstreams) {
    if (names.has(u.name)) throw new Error(`Duplicate upstream name "${u.name}"`);
    names.add(u.name);
  }

  const routes = {};
  for (const [name, r] of Object.entries(fileConfig.routes || {})) {
    if (routes[name]) throw new Error(`Duplicate route "${name}"`);
    routes[name] = normalizeRoute(name, r, upstreams);
  }
  // Auto-create identity routes for every advertised model (unless overridden)
  for (const u of upstreams) {
    for (const m of u.models) {
      if (!routes[m]) routes[m] = { upstream: u.name, model: m, fallbacks: [] };
    }
  }
  if (Object.keys(routes).length === 0) {
    throw new Error('No routes defined. List models in upstreams[].models or define routes explicitly.');
  }

  return { port, requestTimeoutMs, adminToken, routesFile, keyHealthFile, upstreams, routes, configPath };
}

function legacyKeys(fileConfig) {
  let keys = Array.isArray(fileConfig.keys) ? fileConfig.keys : [];
  if (process.env.UPSTREAM_KEYS) {
    keys = process.env.UPSTREAM_KEYS
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .map((apiKey) => ({ apiKey }));
  }
  return keys;
}

function normalizeUpstream(u, i) {
  const name = u.name || `upstream-${i + 1}`;
  const baseUrl = String(u.baseUrl || u.upstreamBaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`Upstream "${name}" is missing baseUrl`);
  const keys = (Array.isArray(u.keys) ? u.keys : []).map((k, j) => ({
    apiKey: String(k.apiKey || '').trim(),
    rpm: Number(k.rpm) || DEFAULT_RPM,
    tpm: Number(k.tpm) || DEFAULT_TPM,
    name: k.name || `key-${j + 1}`,
    limits: k.limits && typeof k.limits === 'object' ? k.limits : {},
  }));
  if (keys.length === 0) throw new Error(`Upstream "${name}" has no keys`);
  if (keys.some((k) => !k.apiKey)) throw new Error(`Upstream "${name}" has a key entry without apiKey`);
  const models = Array.isArray(u.models) ? u.models.map((m) => String(m).trim()).filter(Boolean) : [];
  const adapter = resolveAdapter(u.adapter);
  const rateLimitHeaders = normalizeRateLimitHeaders(u.rateLimitHeaders);
  // How to treat a 401 from this provider. Default 'cooldown' (relaxed): 401 is
  // considered transient and only cools the key for a while. 'disable' keeps the
  // legacy strict behavior: permanently disable the key (persisted in key-health.json).
  const unauthorizedPolicy = u.unauthorizedPolicy === 'disable' ? 'disable' : 'cooldown';
  return { name, baseUrl, models, keys, adapter, rateLimitHeaders, unauthorizedPolicy };
}

/**
 * Normalizes the rateLimitHeaders config: which response headers indicate
 * remaining quota. Defaults to the Cerebras/OpenAI convention.
 */
function normalizeRateLimitHeaders(raw) {
  const base = {
    remainingRequests: 'x-ratelimit-remaining-requests',
    remainingTokens: 'x-ratelimit-remaining-tokens',
  };
  if (!raw || typeof raw !== 'object') return base;
  return {
    remainingRequests: raw.remainingRequests ?? base.remainingRequests,
    remainingTokens: raw.remainingTokens ?? base.remainingTokens,
  };
}

export function normalizeRoute(name, r, upstreams) {
  let target;
  if (typeof r === 'string') {
    const [up, model] = r.split('/');
    target = { upstream: up, model, fallbacks: [] };
  } else if (r && typeof r === 'object') {
    target = {
      upstream: r.upstream,
      model: r.model,
      fallbacks: normalizeFallbacks(r),
    };
  } else {
    throw new Error(`Route "${name}" must be "upstream/model" or { upstream, model }`);
  }
  if (!target.upstream || !upstreams.some((u) => u.name === target.upstream)) {
    throw new Error(`Route "${name}" references unknown upstream "${target.upstream}"`);
  }
  if (!target.model) throw new Error(`Route "${name}" is missing model`);
  return target;
}

/**
 * Supports both legacy `fallback` (single) and new `fallbacks` (array).
 * Returns an ordered array of { upstream, model }.
 */
function normalizeFallbacks(routeDef) {
  const raw = routeDef.fallbacks ?? (routeDef.fallback ? [routeDef.fallback] : []);
  if (!Array.isArray(raw)) throw new Error('fallbacks must be an array');
  return raw.map((fb, i) => {
    const f = typeof fb === 'string' ? { upstream: fb.split('/')[0], model: fb.split('/')[1] } : fb;
    if (!f || !f.upstream || !f.model) {
      throw new Error(`fallbacks[${i}] must be "upstream/model" or { upstream, model }`);
    }
    return { upstream: f.upstream, model: f.model };
  });
}
