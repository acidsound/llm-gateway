import { randomUUID } from 'node:crypto';
import { CORS_HEADERS, sendJson } from './common.js';
import { createLogger } from './logger.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
  'expect',
  'accept-encoding',
  'authorization',
  'x-api-key',
]);

const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'set-cookie',
]);

/**
 * OpenAI-compatible gateway that exposes a single endpoint (/v1/*) and routes
 * requests to multiple upstream providers by the caller's model name.
 *
 * - routes: caller model -> { upstream, model, fallback? } (model is rewritten
 *   to the provider's real model id before forwarding)
 * - each upstream has its own key pool with per-(key, model) rate-limit tracking
 * - retryable failures (429 / 5xx / network) rotate keys within a provider;
 *   when a provider is fully exhausted, the route's fallback provider is tried
 */
export class UpstreamProxy {
  constructor({ upstreams, routes, logger, timeoutMs = 300_000, maxBodyBytes = 20 * 1024 * 1024 }) {
    this.upstreams = upstreams; // [{ name, baseUrl, pool }]
    this.upstreamMap = new Map(upstreams.map((u) => [u.name, u]));
    this.routes = routes; // { callerModel: { upstream, model, fallback } }
    this.log = logger ?? createLogger('info');
    this.timeoutMs = timeoutMs;
    this.maxBodyBytes = maxBodyBytes;
  }

  /** Model names the proxy accepts (sorted), for /v1/models and error messages. */
  availableModels() {
    return Object.keys(this.routes).sort();
  }

  async handle(req, res) {
    const reqUrl = new URL(req.url, 'http://proxy.local');
    const body = await this.readBody(req);
    const parsed = body.length ? this.safeParse(body) : null;
    const callerModel =
      parsed && typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;

    if (!callerModel) {
      this.sendError(res, 400, 'The "model" field is required in the request body.', null, 'invalid_request_error');
      return;
    }
    const route = this.routes[callerModel];
    if (!route) {
      this.sendError(
        res,
        400,
        `Unknown model "${callerModel}". Available models: ${this.availableModels().join(', ')}`,
        null,
        'invalid_request_error'
      );
      return;
    }

    const wantsStream = this.wantsStream(body);
    const targets = [route, ...(route.fallback ? [route.fallback] : [])];
    let last = null;

    for (const target of targets) {
      const upstream = this.upstreamMap.get(target.upstream);
      if (!upstream) {
        last = { status: 503, kind: 'config', message: `upstream "${target.upstream}" not found` };
        continue;
      }

      // Rewrite the caller model to this provider's real model id.
      let targetBody = body;
      if (target.model !== parsed.model) {
        targetBody = Buffer.from(JSON.stringify({ ...parsed, model: target.model }));
      }
      const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, upstream.baseUrl);

      const outcome = await this.attemptUpstream(upstream, target.model, {
        res,
        method: req.method,
        upstreamUrl,
        clientHeaders: req.headers,
        body: targetBody,
        stream: wantsStream,
        reqUrl,
        pool: upstream.pool,
      });
      if (outcome.delivered) return;

      last = outcome.lastError;
      if (targets.length > 1) {
        this.log.warn(`${req.method} ${reqUrl.pathname} (model: ${callerModel}): provider "${upstream.name}" exhausted; trying fallback`);
      }
    }

    const status = last?.status === 429 ? 429 : last?.kind === 'timeout' ? 504 : 503;
    const message =
      last && last.status === 503 && last.kind === 'config'
        ? last.message
        : `No available keys for model "${callerModel}". Last error: ${last ? last.message : 'unknown'}`;
    this.log.warn(`${req.method} ${reqUrl.pathname} (model: ${callerModel}): ${message}`);
    // Retry-After is only meaningful for 429; for 5xx/timeout the client should
    // retry with its own backoff.
    const retryAfterSec = status === 429 ? this.nextRetryAfter(callerModel) : null;
    this.sendError(res, status, message, retryAfterSec, status === 429 ? 'rate_limit_error' : 'proxy_error');
  }

  /** Try every key of one provider for a model. Returns { delivered } or { delivered: false, lastError }. */
  async attemptUpstream(upstream, model, ctx) {
    const pool = upstream.pool;
    const attempted = [];
    let last = null;

    while (true) {
      const sel = pool.select(attempted, model);
      if (!sel) break;
      attempted.push(sel.key.index);

      if (sel.cooling) {
        last = { status: 429, kind: 'rate_limited', message: `key "${sel.key.name}" is cooling down` };
        break;
      }

      pool.recordRequestStart(sel.key, model, this.estimateTokens(ctx.body));
      const result = await this.forward(sel.key, model, ctx);

      if (result.ok) {
        const status = result.upstream.status;
        if (RETRYABLE_STATUS.has(status) || status === 401) {
          await this.cancelBody(result.upstream);
          this.handleFailure(pool, result.key, model, { status, upstream: result.upstream, kind: 'status' });
          last = { status, kind: 'status', message: `upstream ${status} on key "${result.key.name}"` };
          continue;
        }
        // Success, or a client error (4xx) that no other key/provider would fix: forward as-is.
        pool.recordSuccess(result.key, model);
        if (status >= 400) pool.unrecord(result.key, model);
        this.log.debug(`[${upstream.name}/${result.key.name}] served ${ctx.reqUrl.pathname} (model: ${model}) -> ${status}`);
        await this.pipeToClient(ctx.res, result.upstream, upstream, result.key, ctx.stream);
        return { delivered: true };
      }

      // Network error / timeout
      this.handleFailure(pool, result.key, model, result);
      last = result;
      continue;
    }

    return { delivered: false, lastError: last };
  }

  async forward(key, model, { method, upstreamUrl, clientHeaders, body, stream, pool }) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(clientHeaders)) {
      if (!value || SKIP_REQUEST_HEADERS.has(name)) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v);
      } else {
        headers.set(name, value);
      }
    }
    headers.set('authorization', `Bearer ${key.apiKey}`);

    const ac = new AbortController();
    let timer = null;
    // Streaming responses can run arbitrarily long; only non-stream requests get a timeout.
    if (!stream && this.timeoutMs > 0) {
      timer = setTimeout(() => ac.abort(new Error(`upstream request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    }

    try {
      const resp = await fetch(upstreamUrl, {
        method,
        headers,
        body: body && body.length ? body : undefined,
        signal: ac.signal,
        redirect: 'follow',
      });
      this.observeRateLimitHeaders(pool, key, model, resp.headers);
      return { ok: true, upstream: resp, key };
    } catch (err) {
      const aborted = ac.signal.aborted;
      return {
        ok: false,
        key,
        kind: aborted ? 'timeout' : 'network',
        status: aborted ? 504 : 502,
        message: err.message,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async pipeToClient(res, upstream, upstreamConf, key, isStream) {
    const status = upstream.status;
    const body = upstream.body;

    if (!body) {
      res.writeHead(status, this.buildResponseHeaders(upstream, upstreamConf, key, isStream));
      res.end();
      return;
    }

    if (isStream) {
      res.writeHead(status, this.buildResponseHeaders(upstream, upstreamConf, key, true));
      res.flushHeaders();
      const ac = new AbortController();
      const onResClose = () => {
        // Client hung up before the stream finished -> abort upstream.
        if (!res.writableEnded) ac.abort();
      };
      res.on('close', onResClose);
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.destroyed) break;
          res.write(value);
        }
        if (!res.destroyed) res.end();
      } catch {
        // Upstream stream broke or was aborted due to client disconnect.
        if (!res.destroyed && !res.writableEnded) res.end();
      } finally {
        res.off('close', onResClose);
      }
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(status, { ...this.buildResponseHeaders(upstream, upstreamConf, key, false), 'content-length': buf.length });
    res.end(buf);
  }

  buildResponseHeaders(upstream, upstreamConf, key, isStream) {
    const headers = { ...CORS_HEADERS };
    upstream.headers.forEach((value, name) => {
      if (SKIP_RESPONSE_HEADERS.has(name)) return;
      headers[name] = value;
    });
    headers['x-proxy-key'] = `${upstreamConf.name}/${key.name}`;
    headers['x-request-id'] = headers['x-request-id'] || randomUUID();
    if (isStream) {
      headers['cache-control'] = 'no-cache';
      headers['connection'] = 'keep-alive';
    }
    return headers;
  }

  observeRateLimitHeaders(pool, key, model, headers) {
    const remReq = headers.get('x-ratelimit-remaining-requests');
    const remTok = headers.get('x-ratelimit-remaining-tokens');
    if ((remReq !== null && Number(remReq) <= 0) || (remTok !== null && Number(remTok) <= 0)) {
      pool.preemptiveCooldown(key, model);
    }
  }

  handleFailure(pool, key, model, { status, upstream, kind, message }) {
    const modelLabel = model || '(unspecified)';
    if (status === 401) {
      pool.markInvalid(key, 'upstream returned 401 Unauthorized (invalid API key)');
      this.log.error(`[key:${key.name}] permanently disabled: invalid API key (401)`);
    } else if (status === 429) {
      const ms = pool.cooldownFromHeaders(key, model, upstream ? upstream.headers : null);
      pool.markModelCooldown(key, model, ms);
      this.log.warn(`[key:${key.name}] rate limited (429) on model "${modelLabel}"; cooling for ${Math.round(ms / 1000)}s`);
    } else if (status >= 500) {
      const ms = pool.backoffMs(key, 2000);
      pool.markKeyFailure(key, model, ms, '5xx');
      this.log.warn(`[key:${key.name}] upstream ${status} on model "${modelLabel}"; cooling whole key for ${Math.round(ms / 1000)}s`);
    } else if (kind === 'timeout') {
      const ms = pool.backoffMs(key, 1000);
      pool.markKeyFailure(key, model, ms, 'timeout');
      this.log.warn(`[key:${key.name}] request timed out; cooling whole key for ${Math.round(ms / 1000)}s`);
    } else if (kind === 'network') {
      const ms = pool.backoffMs(key, 1000);
      pool.markKeyFailure(key, model, ms, 'network');
      this.log.warn(`[key:${key.name}] network error (${message || 'unknown'}); cooling whole key for ${Math.round(ms / 1000)}s`);
    }
  }

  sendError(res, status, message, retryAfterSec, type = status === 429 ? 'rate_limit_error' : 'proxy_error') {
    const headers = {};
    if (retryAfterSec != null && retryAfterSec >= 0) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSec)));
    }
    sendJson(res, status, { error: { message, type, code: status } }, headers);
  }

  nextRetryAfter(model) {
    let best = 60;
    for (const u of this.upstreams) best = Math.min(best, u.pool.nextRetryAfter(model));
    return best;
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > this.maxBodyBytes) {
          const err = new Error('Request body too large');
          err.statusCode = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  safeParse(buf) {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }

  wantsStream(body) {
    if (!body || !body.length) return false;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      return parsed.stream === true || parsed.stream === 'true' || parsed.stream === 1;
    } catch {
      return false;
    }
  }

  /** Rough token estimate used for per-key TPM load balancing (chars / 4). */
  estimateTokens(body) {
    if (!body || !body.length) return 0;
    try {
      const p = JSON.parse(body.toString('utf8'));
      const input = JSON.stringify(p.messages ?? p.prompt ?? p.input ?? '');
      const maxOut = Number(p.max_tokens ?? p.max_completion_tokens ?? 0) || 0;
      return Math.ceil((input.length + maxOut) / 4);
    } catch {
      return Math.ceil(body.length / 4);
    }
  }

  async cancelBody(upstream) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* ignore */
    }
  }
}
