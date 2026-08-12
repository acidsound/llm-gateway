const WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Manages the pool of upstream API keys with per-(key, model) rate-limit tracking.
 *
 * Rate limits are per model (and per account tier), so:
 * - usage windows (RPM/TPM) are tracked per model per key
 * - a 429 cools down only the affected model on that key
 * - 5xx / network / timeout errors cool down the whole key
 * - a 401 permanently disables the whole key
 * - per-key `limits` (model -> { rpm, tpm }) override the key defaults
 */
export class KeyPool {
  constructor(keys) {
    this.keys = keys.map((k, i) => ({
      ...k,
      index: i,
      rpm: Number(k.rpm) || 30,
      tpm: Number(k.tpm) || 30_000,
      limits: k.limits && typeof k.limits === 'object' ? k.limits : {},
      cooldownUntil: 0, // global cooldown (5xx / network / timeout)
      consecutiveFailures: 0,
      disabled: false,
      disabledReason: null,
      models: new Map(), // model -> { name, window: [{at, tokens}], cooldownUntil, consecutiveFailures, total429s, total5xx }
      totalRequests: 0,
      lastUsedAt: 0,
    }));
    this.rr = 0;
  }

  limitsFor(key, model) {
    return (model && key.limits[model]) || { rpm: key.rpm, tpm: key.tpm };
  }

  _rec(key, model) {
    const name = model || '_';
    let rec = key.models.get(name);
    if (!rec) {
      rec = { name, window: [], cooldownUntil: 0, consecutiveFailures: 0, total429s: 0, total5xx: 0 };
      key.models.set(name, rec);
    }
    return rec;
  }

  _trimWindow(rec, now = Date.now()) {
    const cutoff = now - WINDOW_MS;
    const w = rec.window;
    while (w.length && w[0].at <= cutoff) w.shift();
    return w;
  }

  requestCount(key, model, now = Date.now()) {
    const rec = key.models.get(model || '_');
    return rec ? this._trimWindow(rec, now).length : 0;
  }

  tokenCount(key, model, now = Date.now()) {
    const rec = key.models.get(model || '_');
    return rec ? this._trimWindow(rec, now).reduce((s, e) => s + e.tokens, 0) : 0;
  }

  /** Higher of RPM and TPM utilization for the given model, 0..1+. */
  utilization(key, model, now = Date.now()) {
    const { rpm, tpm } = this.limitsFor(key, model);
    return Math.max(
      this.requestCount(key, model, now) / (rpm || 1),
      this.tokenCount(key, model, now) / (tpm || 1)
    );
  }

  isCooling(key, model, now = Date.now()) {
    if (key.cooldownUntil > now) return true; // whole-key cooldown
    const rec = key.models.get(model || '_');
    return rec ? rec.cooldownUntil > now : false; // per-model cooldown
  }

  /**
   * Pick the best key for the next attempt, excluding keys already tried in
   * this request. Considers the requested model's utilization and cooldowns.
   * Returns { key, cooling } or null when no candidate remains.
   */
  select(exclude = [], model = null) {
    const now = Date.now();
    const tried = new Set(exclude);
    const candidates = this.keys.filter((k) => !k.disabled && !tried.has(k.index));
    if (candidates.length === 0) return null;

    const ready = candidates.filter((k) => !this.isCooling(k, model, now));
    const pool = ready.length ? ready : candidates;

    pool.sort((a, b) => this.utilization(a, model, now) - this.utilization(b, model, now));
    const bestUtil = this.utilization(pool[0], model, now);
    const tied = pool.filter((k) => this.utilization(k, model, now) === bestUtil);
    const chosen = tied[this.rr % tied.length];
    this.rr++;

    return { key: chosen, cooling: this.isCooling(chosen, model, now) };
  }

  recordRequestStart(key, model, tokens = 0) {
    const rec = this._rec(key, model);
    const now = Date.now();
    rec.window.push({ at: now, tokens });
    key.totalRequests++;
    key.lastUsedAt = now;
  }

  /** Remove the most recent window entry for this model (e.g. 4xx rejection). */
  unrecord(key, model) {
    const rec = key.models.get(model || '_');
    if (rec) rec.window.pop();
    key.totalRequests = Math.max(0, key.totalRequests - 1);
  }

  recordSuccess(key, model) {
    key.consecutiveFailures = 0;
    const rec = key.models.get(model || '_');
    if (rec) rec.consecutiveFailures = 0;
  }

  /** Whole-key cooldown for model-independent failures (5xx / network / timeout). */
  markKeyFailure(key, model, ms, kind) {
    key.cooldownUntil = Math.max(key.cooldownUntil, Date.now() + ms);
    key.consecutiveFailures++;
    if (kind === '5xx') {
      const rec = this._rec(key, model);
      rec.total5xx++;
    }
  }

  /** Per-model cooldown for 429s. */
  markModelCooldown(key, model, ms) {
    const rec = this._rec(key, model);
    rec.cooldownUntil = Math.max(rec.cooldownUntil, Date.now() + ms);
    rec.consecutiveFailures++;
    rec.total429s++;
  }

  /** Preemptive cooldown from x-ratelimit-remaining-* headers (quota exhausted). */
  preemptiveCooldown(key, model) {
    const rec = this._rec(key, model);
    rec.cooldownUntil = Math.max(rec.cooldownUntil, Date.now() + WINDOW_MS);
  }

  markInvalid(key, reason) {
    key.disabled = true;
    key.disabledReason = reason;
  }

  backoffMs(key, baseMs) {
    const exp = Math.min(key.consecutiveFailures, 5);
    return Math.min(baseMs * 2 ** exp, MAX_BACKOFF_MS);
  }

  backoffMsModel(key, model, baseMs) {
    const rec = this._rec(key, model);
    const exp = Math.min(rec.consecutiveFailures, 5);
    return Math.min(baseMs * 2 ** exp, MAX_BACKOFF_MS);
  }

  /** Cooldown duration after a 429, honoring retry-after when present. */
  cooldownFromHeaders(key, model, headers) {
    if (headers) {
      const retryAfter = parseRetryAfter(headers);
      if (retryAfter != null) return Math.min(retryAfter * 1000 + 1000, 300_000);
      const remReq = headers.get('x-ratelimit-remaining-requests');
      const remTok = headers.get('x-ratelimit-remaining-tokens');
      if (remReq !== null && Number(remReq) <= 0) return WINDOW_MS;
      if (remTok !== null && Number(remTok) <= 0) return WINDOW_MS;
    }
    return this.backoffMsModel(key, model, 1000);
  }

  /** Seconds until the soonest cooldown expiry for the given model (for Retry-After). */
  nextRetryAfter(model = null) {
    const now = Date.now();
    const times = [];
    for (const k of this.keys) {
      if (k.disabled) continue;
      times.push(Math.max(0, k.cooldownUntil - now));
      const rec = k.models.get(model || '_');
      if (rec) times.push(Math.max(0, rec.cooldownUntil - now));
    }
    return times.length ? Math.min(...times) / 1000 : 60;
  }

  status() {
    const now = Date.now();
    return this.keys.map((k) => {
      const globalCooling = k.cooldownUntil > now;
      return {
        name: k.name,
        state: k.disabled ? 'disabled' : globalCooling ? 'cooling' : 'ready',
        retryAfterSec: k.disabled ? null : Math.max(0, Math.round((k.cooldownUntil - now) / 1000)),
        defaultLimits: { rpm: k.rpm, tpm: k.tpm },
        modelLimits: k.limits,
        totalRequests: k.totalRequests,
        lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
        disabledReason: k.disabledReason,
        models: [...k.models.values()].map((rec) => {
          const { rpm, tpm } = this.limitsFor(k, rec.name === '_' ? null : rec.name);
          const trimmed = this._trimWindow(rec, now);
          const reqs = trimmed.length;
          const toks = trimmed.reduce((s, e) => s + e.tokens, 0);
          return {
            model: rec.name === '_' ? '(unspecified)' : rec.name,
            state: rec.cooldownUntil > now ? 'cooling' : 'ready',
            retryAfterSec: Math.max(0, Math.round((rec.cooldownUntil - now) / 1000)),
            rpm,
            tpm,
            requestsInWindow: reqs,
            tokensInWindow: toks,
            utilization: Number(Math.max(reqs / (rpm || 1), toks / (tpm || 1)).toFixed(3)),
            total429s: rec.total429s,
            total5xx: rec.total5xx,
          };
        }),
      };
    });
  }
}

function parseRetryAfter(headers) {
  const v = headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000);
  return null;
}
