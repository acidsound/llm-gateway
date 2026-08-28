import fs from 'node:fs';
import { normalizeRoute } from './config.js';

/**
 * Holds the route map (caller model -> { upstream, model, fallback }) at runtime.
 *
 * - starts from the routes defined in config.json (explicit + auto from upstreams[].models)
 * - runtime changes made through the admin API are persisted to a JSON file and
 *   restored on restart; persisted entries override config entries with the same name
 * - only entries that DIFFER from the config baseline are persisted, and deletions
 *   of baseline routes are persisted as tombstones (null), so they survive restarts
 * - the underlying `routes` object is mutated in place so the proxy sees changes immediately
 */
export class RouteStore {
  constructor({ upstreams, initialRoutes = {}, file = null, logger = console }) {
    this.upstreams = upstreams;
    this.file = file;
    this.log = logger;
    this.initial = { ...initialRoutes };
    this.routes = { ...initialRoutes };
    /**
     * Map of model-route-key -> last-used timestamp (ms).
     * Updated by `touch()`, used by `catalog()` to order models by recency.
     * Not persisted — resets to alphabetical on restart.
     * @type {Map<string, number>}
     */
    this.lastUsedAt = new Map();
    this.patterns = []; // glob patterns extracted from route keys (e.g. "llama-*")
    this.extractPatterns();

    if (file && fs.existsSync(file)) {
      let loaded = 0;
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [name, r] of Object.entries(saved)) {
          if (r === null) {
            delete this.routes[name]; // tombstone: this route was deleted at runtime
            continue;
          }
          try {
            this.routes[name] = normalizeRoute(name, r, upstreams);
            loaded++;
          } catch (err) {
            this.log.warn(`skipping persisted route "${name}": ${err.message}`);
          }
        }
      } catch (err) {
        this.log.error(`Failed to read persisted routes from ${file}: ${err.message}`);
      }
      if (loaded > 0) this.log.info(`Loaded ${loaded} persisted route(s) from ${file}`);
      this.extractPatterns();
    }
  }

  /** Extract glob patterns (keys containing *) from the route map. */
  extractPatterns() {
    this.patterns = Object.keys(this.routes)
      .filter((k) => k.includes('*'))
      .map((k) => ({ pattern: k, regex: globToRegex(k) }))
      .sort((a, b) => b.pattern.length - a.pattern.length); // longest match first
  }

  /** The route key that matches a model name: exact key or the glob pattern. */
  routeKeyFor(model) {
    if (model in this.routes) return model;
    for (const { pattern, regex } of this.patterns) {
      if (regex.test(model)) return pattern;
    }
    return null;
  }

  get(model) {
    const key = this.routeKeyFor(model);
    return key ? this.routes[key] : undefined;
  }

  /**
   * Resolve a model name to a route, trying exact match then glob patterns.
   * Returns the route object or undefined.
   */
  resolve(model) {
    const key = this.routeKeyFor(model);
    return key ? this.routes[key] : undefined;
  }

  /**
   * Record that a model was just used so the catalog can order by recency.
   * The caller model name is resolved to its route key (exact or glob), so the
   * timestamp lands on the catalog entry callers actually see. No-op for
   * unknown models. `at` is overridable for deterministic tests.
   */
  touch(model, at = Date.now()) {
    const key = this.routeKeyFor(model);
    if (key) this.lastUsedAt.set(key, at);
    return key != null;
  }

  list() {
    return { ...this.routes };
  }

  availableModels() {
    return Object.keys(this.routes).sort();
  }

  /**
   * Model ids ordered for display: most recently used first, then
   * alphabetically for models that have never been used (or tied timestamps).
   */
  orderedModels() {
    const ids = Object.keys(this.routes);
    ids.sort((a, b) => {
      const ta = this.lastUsedAt.get(a) || 0;
      const tb = this.lastUsedAt.get(b) || 0;
      if (ta !== tb) return tb - ta; // most recently used first
      return a.localeCompare(b); // stable alphabetical tiebreak
    });
    return ids;
  }

  /**
   * Build the OpenAI-compatible model catalog for /v1/models (and /models).
   * `owned_by` reflects the upstream(s) that can serve each model: the route's
   * primary upstream plus any distinct fallback upstreams (e.g. "b.ai, orca").
   * Falls back to "proxy" for a route without a resolvable upstream.
   */
  catalog() {
    return this.orderedModels().map((id) => {
      const route = this.routes[id];
      const upstreams = route
        ? [route.upstream, ...(route.fallbacks || []).map((f) => f.upstream)]
            .filter((v, i, a) => a.indexOf(v) === i) // de-dupe, keep order
        : [];
      return {
        id,
        object: 'model',
        created: 0,
        owned_by: upstreams.length > 0 ? upstreams.join(', ') : 'proxy',
      };
    });
  }

  /** Validate and upsert a route. Throws on invalid targets. */
  set(model, spec) {
    const route = normalizeRoute(model, spec, this.upstreams);
    this.routes[model] = route;
    if (model.includes('*')) this.extractPatterns();
    return route;
  }

  /** Remove a route. Returns true if it existed. */
  delete(model) {
    if (!(model in this.routes)) return false;
    delete this.routes[model];
    this.lastUsedAt.delete(model);
    if (model.includes('*')) this.extractPatterns();
    return true;
  }

  /**
   * Persist only the diff against the config baseline (new/changed routes, plus
   * tombstones for deleted baseline routes). Never throws.
   */
  async persist() {
    if (!this.file) return false;
    const out = {};
    for (const [name, route] of Object.entries(this.routes)) {
      const base = this.initial[name];
      if (base && JSON.stringify(base) === JSON.stringify(route)) continue; // unchanged baseline
      out[name] = route;
    }
    for (const name of Object.keys(this.initial)) {
      if (!(name in this.routes)) out[name] = null; // deleted baseline route -> tombstone
    }
    try {
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(out, null, 2) + '\n');
      await fs.promises.rename(tmp, this.file);
      return true;
    } catch (err) {
      this.log.error(`failed to persist routes to ${this.file}: ${err.message}`);
      return false;
    }
  }
}

/**
 * Convert a glob pattern (with * wildcards) to a RegExp.
 * "llama-*" -> /^llama-.*$/
 * "gpt-*"   -> /^gpt-.*$/
 */
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
