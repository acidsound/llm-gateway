// Live end-to-end verification against a running llm-gateway + real upstream API.
// Usage: node scripts/verify-live.js [baseUrl]
const BASE = process.argv[2] || 'http://localhost:8787';
const MODEL_FALLBACK = 'llama-3.3-70b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. health
  const health = await fetch(`${BASE}/health`).then(async (r) => ({ status: r.status, body: await r.json() }));
  console.log('[1] /health ->', health.status, 'readyKeys:', health.body.readyKeys, '/', health.body.totalKeys);

  // 2. models
  let model = MODEL_FALLBACK;
  try {
    const res = await fetch(`${BASE}/v1/models`);
    const json = await res.json();
    if (res.ok && Array.isArray(json.data) && json.data.length) {
      model = json.data[0].id;
      console.log('[2] /v1/models ->', res.status, '| first model:', model, `| total: ${json.data.length}`);
    } else {
      console.log('[2] /v1/models ->', res.status, '| falling back to', model);
    }
  } catch (err) {
    console.log('[2] /v1/models -> ERROR:', err.message, '| falling back to', model);
  }

  const chat = (stream) => ({
    model,
    messages: [{ role: 'user', content: '한 문장으로 인사해줘.' }],
    max_tokens: 64,
    ...(stream ? { stream: true } : {}),
  });

  // 3. non-streaming
  {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chat(false)),
    });
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? '(none)';
    console.log(
      `[3] non-stream -> ${res.status} (${Date.now() - t0}ms) | key: ${res.headers.get('x-proxy-key')} | content: ${JSON.stringify(content.slice(0, 60))}`
    );
  }

  // 4. streaming (SSE)
  {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(chat(true)),
    });
    const text = await res.text();
    const chunks = (text.match(/data: /g) || []).length;
    const done = text.includes('data: [DONE]');
    console.log(
      `[4] stream   -> ${res.status} (${Date.now() - t0}ms) | key: ${res.headers.get('x-proxy-key')} | chunks: ${chunks} | [DONE]: ${done}`
    );
  }

  // 5. rotation check: 5 quick requests, count distinct keys
  {
    const used = new Map();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chat(false)),
      });
      const key = res.headers.get('x-proxy-key') || '?';
      used.set(key, (used.get(key) || 0) + 1);
      if (!res.ok) console.log(`[5] req ${i + 1} -> ${res.status} (${key})`);
      await sleep(300);
    }
    console.log('[5] rotation over 5 requests:', [...used.entries()].map(([k, n]) => `${k}×${n}`).join(', '));
  }

  // 6. stats
  {
    const res = await fetch(`${BASE}/stats`);
    const json = await res.json();
    const line = json.upstreams
      .map((u) => {
        const keys = u.keys
          .map((k) => {
            const ms = k.models.map((m) => `${m.model}:${m.state}(${m.utilization})`).join(' ') || '(no traffic)';
            return `${k.name}:${k.state}[${ms}]`;
          })
          .join(' ');
        return `${u.name} { ${keys} }`;
      })
      .join(' | ');
    console.log(`[6] /stats -> ${res.status} | ${line}`);
  }
}

main().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
