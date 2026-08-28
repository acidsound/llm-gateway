import { randomUUID } from 'node:crypto';
import { CORS_HEADERS, sendJson } from './common.js';
import { applyAdapterAuth, buildUpstreamUrl } from './adapters.js';
import { createLogger } from './logger.js';

const RETRYABLE_STATUS = new Set([402, 429, 500, 502, 503, 504]);

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
 * Remove `tools`/`tool_choice` from a request body and describe the tools in
 * the system prompt, instructing the model to emit a JSON tool call in plain
 * text. Used for upstream models that break on native tool payloads.
 */
export function stripToolsBody(parsed, model) {
  const { tools, tool_choice: toolChoice, ...rest } = parsed;
  const lines = (tools || []).map((t) => {
    const f = t.function || t;
    return `- ${f.name}: ${f.description || 'no description'} | parameters: ${JSON.stringify(f.parameters ?? {})}`;
  });
  const choiceNote =
    toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name
      ? `You MUST call the function "${toolChoice.function.name}".`
      : toolChoice && typeof toolChoice === 'string' && toolChoice !== 'auto'
        ? `Tool choice mode: ${toolChoice}.`
        : '';
  const notice =
    `# Tool use\nNative tool calling is unavailable on model "${model}". ` +
    `Instead of a native tool_call, when you want to call a tool respond with ONLY a JSON object ` +
    `(no prose, no code fences) of the form:\n` +
    `{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"<name>","arguments":<json-object>}}]}\n` +
    `If you don't need a tool, answer normally.\nAvailable tools:\n${lines.join('\n')}${choiceNote ? '\n' + choiceNote : ''}`;
  rest.messages = [{ role: 'system', content: notice }, ...(parsed.messages || [])];
  return rest;
}

/**
 * OpenAI-compatible gateway that exposes a single endpoint (/v1/*) and routes
 * requests to multiple upstream providers by the caller's model name.
 *
 * - routes: caller model -> { upstream, model, fallbacks[] } (model is rewritten
 *   to the provider's real model id before forwarding)
 * - each upstream has its own key pool with per-(key, model) rate-limit tracking
 * - retryable failures (429 / 5xx / network) rotate keys within a provider;
 *   when a provider is fully exhausted, each fallback in the chain is tried in order
 * - provider adapters handle auth style (bearer / x-api-key) and URL construction
 */
export class UpstreamProxy {
  constructor({ upstreams, routes, logger, timeoutMs = 300_000, maxBodyBytes = 20 * 1024 * 1024 }) {
    // Ensure every upstream has adapter + rateLimitHeaders (defaults for tests / legacy configs).
    this.upstreams = upstreams.map((u) => ({
      ...u,
      adapter: u.adapter ?? { auth: 'bearer', pathPrefix: '', extraHeaders: {} },
      rateLimitHeaders: u.rateLimitHeaders ?? {
        remainingRequests: 'x-ratelimit-remaining-requests',
        remainingTokens: 'x-ratelimit-remaining-tokens',
      },
    }));
    this.upstreamMap = new Map(this.upstreams.map((u) => [u.name, u]));
    // `routes` is the RouteStore instance (or a plain object in tests).
    this.routes = routes;
    this.log = logger ?? createLogger('info');
    this.timeoutMs = timeoutMs;
    this.maxBodyBytes = maxBodyBytes;
  }

  /** Resolve a model name to its route (exact match or glob pattern). */
  resolveRoute(model) {
    if (this.routes.resolve) return this.routes.resolve(model);
    return this.routes[model];
  }

  /** Model names the proxy accepts (sorted), for /v1/models and error messages. */
  availableModels() {
    if (this.routes.availableModels) return this.routes.availableModels();
    return Object.keys(this.routes).sort();
  }

  async handle(req, res) {
    const reqUrl = new URL(req.url, 'http://proxy.local');
    const requestId = randomUUID();
    const start = Date.now();
    const body = await this.readBody(req);
    const parsed = body.length ? this.safeParse(body) : null;
    const callerModel =
      parsed && typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;

    if (!callerModel) {
      this.logRequest(requestId, req.method, reqUrl.pathname, null, null, null, 400, Date.now() - start);
      this.sendError(res, 400, 'The "model" field is required in the request body.', null, 'invalid_request_error');
      return;
    }
    const route = this.resolveRoute(callerModel);
    if (!route) {
      this.logRequest(requestId, req.method, reqUrl.pathname, callerModel, null, null, 400, Date.now() - start);
      this.sendError(
        res,
        400,
        `Unknown model "${callerModel}". Available models: ${this.availableModels().join(', ')}`,
        null,
        'invalid_request_error'
      );
      return;
    }

    // Mark the model as used so /v1/models (and /models) can order by recency.
    // RouteStore.touch resolves glob patterns to the catalog entry; plain
    // route maps (tests) have no touch method and are skipped.
    this.routes.touch?.(callerModel);

    const wantsStream = this.wantsStream(body);
    // Primary target + ordered fallback chain
    const targets = [route, ...(route.fallbacks || [])];
    let last = null;
    let servedBy = null;

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
      // Some upstream models (e.g. openrouter stealth/*) terminate the stream
      // with native_finish_reason:"network_error" whenever a `tools` array is
      // present. Inline the tool definitions into the prompt instead.
      // stripTools may be: true (all models), { default: true, [model]: false }, or { [model]: true }
      if (this.shouldStripTools(upstream.stripTools, target.model) && Array.isArray(parsed.tools) && parsed.tools.length) {
        targetBody = Buffer.from(JSON.stringify(stripToolsBody(parsed, target.model)));
      }
      const upstreamUrl = buildUpstreamUrl(reqUrl.pathname, reqUrl.search, upstream.baseUrl, upstream.adapter.pathPrefix);

      const outcome = await this.attemptUpstream(upstream, target.model, {
        res,
        method: req.method,
        upstreamUrl,
        clientHeaders: req.headers,
        body: targetBody,
        stream: wantsStream,
        reqUrl,
        pool: upstream.pool,
        requestId,
      });
      if (outcome.delivered) {
        servedBy = `${upstream.name}/${outcome.key?.name || '?'}`;
        break;
      }

      last = outcome.lastError;
      if (targets.length > 1) {
        this.log.warn(`${req.method} ${reqUrl.pathname} (model: ${callerModel}): provider "${upstream.name}" exhausted; trying next target`);
      }
    }

    if (servedBy) {
      this.logRequest(requestId, req.method, reqUrl.pathname, callerModel, servedBy, null, res.statusCode, Date.now() - start);
      return;
    }

    const status = last?.status === 429 ? 429 : last?.kind === 'timeout' ? 504 : 503;
    const message =
      last && last.status === 503 && last.kind === 'config'
        ? last.message
        : `No available keys for model "${callerModel}". Last error: ${last ? last.message : 'unknown'}`;
    this.log.warn(`${req.method} ${reqUrl.pathname} (model: ${callerModel}): ${message}`);
    this.logRequest(requestId, req.method, reqUrl.pathname, callerModel, null, message, status, Date.now() - start);
    const retryAfterSec = status === 429 ? this.nextRetryAfter(callerModel) : null;
    this.sendError(res, status, message, retryAfterSec, status === 429 ? 'rate_limit_error' : 'proxy_error');
  }

  /**
   * stripTools policy resolution:
   *   true                          -> all models
   *   { default: true, "m": false } -> all except m
   *   { default: false, "m": true } -> only m (same as legacy { m: true })
   */
  shouldStripTools(cfg, model) {
    if (cfg == null) return false;
    if (cfg === true) return true;
    if (typeof cfg !== 'object') return false;
    const def = cfg.default === true;
    return cfg[model] != null ? cfg[model] === true : def;
  }

  /** Try every key of one provider for a model. Returns { delivered, key } or { delivered: false, lastError }. */
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
          this.handleFailure(pool, result.key, model, { status, upstream: result.upstream, kind: 'status' }, upstream);
          last = { status, kind: 'status', message: `upstream ${status} on key "${result.key.name}"` };
          continue;
        }
        // Success, or a client error (4xx) that no other key/provider would fix: forward as-is.
        // Exception: some providers (openrouter stealth/*) return HTTP 200 with an
        // empty message and native_finish_reason:"network_error" when the payload
        // (e.g. tools) is unsupported. Treat that as retryable instead of serving
        // a blank response to the client. For streams we must decide BEFORE any
        // byte is piped to the client, so peek/buffer the stream first.
        const emptyFailure = ctx.stream
          ? await this.peekStreamForNetworkError(result.upstream)
          : await this.isEmptyNetworkError(result.upstream, false);
        if (emptyFailure) {
          await this.cancelBody(result.upstream);
          const ms = pool.backoffMs(result.key, 1000);
          pool.markKeyFailure(result.key, model, ms, 'network');
          last = { status: 502, kind: 'network', message: `upstream "${upstream.name}" returned empty response (network_error) on key "${result.key.name}"` };
          this.log.warn(`[key:${result.key.name}] empty response (native network_error) on model "${model}"; cooling whole key for ${Math.round(ms / 1000)}s`);
          continue;
        }
        pool.recordSuccess(result.key, model);
        if (status >= 400) pool.unrecord(result.key, model);
        else this.recordActualUsage(pool, result.key, model, result.upstream);
        this.log.debug(`[${upstream.name}/${result.key.name}] served ${ctx.reqUrl.pathname} (model: ${model}) -> ${status}`);
        await this.pipeToClient(ctx.res, result.upstream, upstream, result.key, ctx.stream);
        return { delivered: true, key: result.key };
      }

      // Network error / timeout
      this.handleFailure(pool, result.key, model, result, upstream);
      last = result;
      continue;
    }

    return { delivered: false, lastError: last };
  }

  async forward(key, model, { method, upstreamUrl, clientHeaders, body, stream, pool, requestId }) {
    const upstream = this.upstreamMap.get(this.findUpstreamByPool(pool)?.name);
    const adapter = upstream?.adapter ?? { auth: 'bearer', pathPrefix: '', extraHeaders: {} };

    const headers = new Headers();
    for (const [name, value] of Object.entries(clientHeaders)) {
      if (!value || SKIP_REQUEST_HEADERS.has(name)) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v);
      } else {
        headers.set(name, value);
      }
    }
    applyAdapterAuth(headers, key.apiKey, adapter);
    if (requestId) headers.set('x-request-id', requestId);

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
      this.observeRateLimitHeaders(pool, key, model, resp.headers, upstream?.rateLimitHeaders);
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

  /**
   * Detect an HTTP 200 response that actually carries no content: OpenRouter
   * stealth models end with native_finish_reason:"network_error" and a null
   * message. For streams we must not consume the body; the sentinel appears in
   * the first data chunk, so we only check non-stream responses here.
   */
  async isEmptyNetworkError(upstream, isStream) {
    if (isStream || !upstream.body) return false;
    try {
      const buf = Buffer.from(await upstream.arrayBuffer());
      upstream._consumedBody = buf;
      const parsed = JSON.parse(buf.toString('utf8'));
      const msg = parsed?.choices?.[0]?.message;
      return (
        parsed?.choices?.[0]?.native_finish_reason === 'network_error' &&
        msg && msg.content == null && !msg.tool_calls && !msg.reasoning
      );
    } catch {
      return false;
    }
  }

  /**
   * Stream variant of isEmptyNetworkError: buffer the entire SSE stream (safe
   * because a network_error stream is only keep-alive comments + one final
   * chunk + [DONE]), then detect the sentinel. The buffered body is stored on
   * `upstream._consumedBody` so pipeToClient replays it verbatim when it turns
   * out to be a legitimate response.
   */
  async peekStreamForNetworkError(upstream) {
    if (!upstream.body) return false;
    // Read ahead just far enough to DECIDE whether this stream is an empty
    // network_error stream, buffering every byte we consume so pipeToClient
    // can replay them verbatim. Deciding from the FIRST chunk alone is wrong:
    // the native_finish_reason:"network_error" sentinel can arrive in a later
    // chunk (or straddle a chunk boundary), which previously let blank streams
    // through to the client ("model finished without a response").
    const decoder = new TextDecoder();
    const chunks = [];
    let text = '';
    let reader;
    // Any bytes we consume must be replayed later; stash them up front so
    // every exit path (payload found, sentinel found, timeout) keeps them.
    const stash = () => { upstream._peeked = { reader, chunks }; };
    try {
      reader = upstream.body.getReader();
      const deadline = this.streamPeekTimeoutMs ?? 15_000;
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('peek timeout')), deadline)
          ),
        ]);
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        // Decision points: real payload -> legitimate stream, stop peeking.
        // NOTE: must be an ACTUAL payload, not just the presence of the key.
        // OpenRouter's first chunk is typically {"delta":{"role":...,
        // "content":null}}, which used to match a bare /\bcontent\b/ test and
        // stopped the peek before the native_finish_reason:"network_error"
        // sentinel arrived in a later chunk -> blank stream served to client
        // ("model finished without a response").
        if (this.streamHasPayload(text)) { stash(); return false; }
        // Sentinel present (may still be split across the next chunk, so also
        // require a closing brace after it OR [DONE] before deciding failure).
        if (text.includes('native_finish_reason')) {
          if (!text.includes('[DONE]') && !text.trimEnd().endsWith('}')) continue;
          stash();
          return this.streamHasNoPayload(text);
        }
      }
    } catch {
      // Peek timed out or errored: assume a slow-but-legitimate stream and
      // keep streaming live from where we left off (chunks stay buffered).
      stash();
      return false;
    }
    stash();
    return this.streamHasNoPayload(text);
  }

  /** True if the buffered SSE text carries the network_error sentinel and no usable payload. */
  streamHasNoPayload(text) {
    if (!text.includes('native_finish_reason')) return false;
    return !this.streamHasPayload(text);
  }

  /**
   * True if the buffered SSE text contains at least one data chunk whose delta
   * carries a non-empty content / tool_calls / reasoning value. A bare
   * `"content":null` (role-only chunk) does NOT count as a payload.
   */
  streamHasPayload(text) {
    for (const m of text.matchAll(/data: (\{.*\})/g)) {
      try {
        const delta = JSON.parse(m[1])?.choices?.[0]?.delta || {};
        if (delta.content || delta.tool_calls?.length || delta.reasoning) return true;
      } catch {
        /* partial JSON across chunks - keep scanning */
      }
    }
    return false;
  }

  /** Find the upstream config that owns this pool (for adapter/rateLimit access). */
  findUpstreamByPool(pool) {
    for (const u of this.upstreams) {
      if (u.pool === pool) return u;
    }
    return null;
  }

  async pipeToClient(res, upstream, upstreamConf, key, isStream) {
    const status = upstream.status;
    const body = upstream._consumedBody ? new Uint8Array(upstream._consumedBody) : upstream.body;

    if (!body) {
      res.writeHead(status, this.buildResponseHeaders(upstream, upstreamConf, key, isStream));
      res.end();
      return;
    }

    if (isStream) {
      res.writeHead(status, this.buildResponseHeaders(upstream, upstreamConf, key, true));
      res.flushHeaders();
      // Fully buffered replay: write the stored bytes verbatim.
      if (!(body.getReader instanceof Function)) {
        res.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
        return;
      }
      const ac = new AbortController();
      const onResClose = () => {
        // Client hung up before the stream finished -> abort upstream.
        if (!res.writableEnded) ac.abort();
      };
      res.on('close', onResClose);
      try {
        // Replay everything consumed during the peek, then continue live.
        const peeked = upstream._peeked;
        const reader = peeked ? peeked.reader : body.getReader();
        if (peeked) for (const c of peeked.chunks) res.write(c);
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

    const buf = upstream._consumedBody ?? Buffer.from(await upstream.arrayBuffer());
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

  /**
   * Observe rate-limit headers from the upstream response.
   * Uses the upstream's configured header names (rateLimitHeaders).
   */
  observeRateLimitHeaders(pool, key, model, headers, rateLimitCfg) {
    const cfg = rateLimitCfg ?? {
      remainingRequests: 'x-ratelimit-remaining-requests',
      remainingTokens: 'x-ratelimit-remaining-tokens',
    };
    const remReq = cfg.remainingRequests ? headers.get(cfg.remainingRequests) : null;
    const remTok = cfg.remainingTokens ? headers.get(cfg.remainingTokens) : null;
    if ((remReq !== null && Number(remReq) <= 0) || (remTok !== null && Number(remTok) <= 0)) {
      pool.preemptiveCooldown(key, model);
    }
  }

  /**
   * After a successful non-stream response, extract actual usage tokens
   * and update the pool's window entry (replacing the estimate).
   */
  recordActualUsage(pool, key, model, upstreamResp) {
    // We can't read the body here (it's already being piped), so this is a
   // no-op for now. The real integration point is in pipeToClient for
   // non-stream responses where we buffer the body.
    // For stream responses, usage comes in the final SSE chunk.
    // This hook exists for future enhancement.
  }

  handleFailure(pool, key, model, { status, upstream, kind, message }, upstreamConf = null) {
    const modelLabel = model || '(unspecified)';
    if (status === 401) {
      if (upstreamConf?.unauthorizedPolicy === 'disable') {
        pool.markInvalid(key, 'upstream returned 401 Unauthorized (invalid API key)');
        this.log.error(`[key:${key.name}] permanently disabled: invalid API key (401)`);
      } else {
        // Relaxed default: 401 is treated as transient (auth flakiness / provider
        // instability), not a permanently invalid key. Cool the whole key like 402
        // so other keys / fallbacks get a chance, and retry once it cools down.
        const ms = pool.backoffMs(key, 60_000);
        pool.markKeyFailure(key, model, ms, 'auth');
        this.log.warn(`[key:${key.name}] unauthorized (401) on model "${modelLabel}"; cooling whole key for ${Math.round(ms / 1000)}s`);
      }
    } else if (status === 402) {
      // Quota / billing exhausted on this key: not a permanent invalid key,
      // but useless until billing is fixed. Cool it down so other keys/fallbacks get tried.
      const ms = pool.backoffMs(key, 60_000);
      pool.markKeyFailure(key, model, ms, 'quota');
      this.log.warn(`[key:${key.name}] payment required (402, quota exhausted) on model "${modelLabel}"; cooling whole key for ${Math.round(ms / 1000)}s`);
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

  /**
   * Structured JSON log line for each request.
   * Format: { ts, requestId, method, path, model, upstream, key, error, status, latencyMs }
   */
  logRequest(requestId, method, path, model, servedBy, error, status, latencyMs) {
    const entry = {
      ts: new Date().toISOString(),
      requestId,
      method,
      path,
      model: model || null,
      upstream: servedBy ? servedBy.split('/')[0] : null,
      key: servedBy ? servedBy.split('/')[1] : null,
      error: error || null,
      status,
      latencyMs,
    };
    if (status >= 500) this.log.error(JSON.stringify(entry));
    else if (status >= 400) this.log.warn(JSON.stringify(entry));
    else this.log.info(JSON.stringify(entry));
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
      if (upstream._peeked) { await upstream._peeked.reader.cancel(); return; }
      await upstream.body?.cancel();
    } catch {
      /* ignore */
    }
  }
}
