/**
 * Provider adapters: per-upstream auth, URL, and body transforms.
 *
 * Each upstream can declare an `adapter` (string or object) in config.
 * Built-in adapters: "openai" (default), "anthropic", "google".
 * Custom adapters can be specified inline:
 *   { "auth": "x-api-key", "pathPrefix": "/v1", "transformBody": null }
 */

const ADAPTERS = {
  openai: {
    auth: 'bearer',
    pathPrefix: '',
  },
  anthropic: {
    auth: 'x-api-key',
    pathPrefix: '',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  google: {
    auth: 'bearer',
    pathPrefix: '',
  },
};

/**
 * Resolve an upstream's adapter config.
 * @param {object|string|undefined} raw - upstream.adapter from config
 * @returns {{ auth: string, pathPrefix: string, extraHeaders?: object }}
 */
export function resolveAdapter(raw) {
  if (!raw) return { ...ADAPTERS.openai };
  if (typeof raw === 'string') {
    const known = ADAPTERS[raw];
    if (!known) throw new Error(`Unknown adapter "${raw}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
    return { ...known };
  }
  if (typeof raw === 'object') {
    return {
      auth: raw.auth || 'bearer',
      pathPrefix: raw.pathPrefix || '',
      extraHeaders: raw.extraHeaders || {},
    };
  }
  throw new Error(`Adapter must be a string or object, got ${typeof raw}`);
}

/**
 * Apply adapter auth + extra headers to a Headers object.
 * @param {Headers} headers
 * @param {string} apiKey
 * @param {{ auth: string, extraHeaders?: object }} adapter
 */
export function applyAdapterAuth(headers, apiKey, adapter) {
  switch (adapter.auth) {
    case 'x-api-key':
      headers.set('x-api-key', apiKey);
      break;
    case 'bearer':
    default:
      headers.set('authorization', `Bearer ${apiKey}`);
      break;
  }
  if (adapter.extraHeaders) {
    for (const [k, v] of Object.entries(adapter.extraHeaders)) {
      headers.set(k, v);
    }
  }
}

/**
 * Build the upstream URL from the client request path.
 * @param {string} clientPath - e.g. "/v1/chat/completions"
 * @param {string} clientSearch - e.g. "?foo=bar"
 * @param {string} baseUrl - e.g. "https://api.anthropic.com"
 * @param {string} pathPrefix - adapter path prefix, e.g. "/v1" or ""
 * @returns {URL}
 */
export function buildUpstreamUrl(clientPath, clientSearch, baseUrl, pathPrefix) {
  // Strip the client's leading /v1 if the adapter has its own prefix logic.
  // For openai-compatible: baseUrl already ends in /v1, path is /v1/... -> dedupe.
  let path = clientPath;
  if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) {
    // baseUrl has /v1, path has /v1/ -> strip path's /v1 to avoid /v1/v1/
    path = path.slice(3); // remove "/v1"
  }
  if (pathPrefix && !path.startsWith(pathPrefix)) {
    path = pathPrefix + path;
  }
  return new URL(path + clientSearch, baseUrl);
}
