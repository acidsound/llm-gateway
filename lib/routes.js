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
    }
  }

  get(model) {
    return this.routes[model];
  }

  list() {
    return { ...this.routes };
  }

  availableModels() {
    return Object.keys(this.routes).sort();
  }

  /** Validate and upsert a route. Throws on invalid targets. */
  set(model, spec) {
    const route = normalizeRoute(model, spec, this.upstreams);
    this.routes[model] = route;
    return route;
  }

  /** Remove a route. Returns true if it existed. */
  delete(model) {
    if (!(model in this.routes)) return false;
    delete this.routes[model];
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
