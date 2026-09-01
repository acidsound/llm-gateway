import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** Grab a free TCP port so the child server can bind without colliding. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** Boot the real server.js against an isolated config, return { port, kill }. */
async function bootGateway() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-models-'));
  const cfg = {
    upstreams: [
      {
        name: 'bai',
        baseUrl: 'https://fake.example/v1',
        models: ['qwen3.8-flash', 'deepseek-v4-flash-vision-exp'],
        keys: [{ name: 'k1', apiKey: 'sk-fake' }],
      },
    ],
  };
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_PATH: cfgPath,
      ROUTES_FILE: path.join(dir, 'routes.json'),
      KEY_HEALTH_FILE: path.join(dir, 'key-health.json'),
      LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });

  // Wait until the HTTP server answers.
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/v1/models`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port, child, dir, kill: () => { child.kill('SIGKILL'); } };
}

test('GET /v1/models/{model} returns the model (OpenAI single-model retrieval)', async () => {
  const gw = await bootGateway();
  try {
    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/models/qwen3.8-flash`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { id: 'qwen3.8-flash', object: 'model', created: 0, owned_by: 'bai' });
  } finally {
    gw.kill();
  }
});

test('GET /models/{model} (alternate path) resolves the same way', async () => {
  const gw = await bootGateway();
  try {
    const res = await fetch(`http://127.0.0.1:${gw.port}/models/qwen3.8-flash`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'qwen3.8-flash');
    assert.equal(body.object, 'model');
  } finally {
    gw.kill();
  }
});

test('GET /v1/models/{unknown} returns 404 with an OpenAI error shape', async () => {
  const gw = await bootGateway();
  try {
    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/models/not-a-model`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.code, 404);
    assert.match(body.error.message, /Model not found/);
  } finally {
    gw.kill();
  }
});

test('GET /v1/models list is unaffected by the single-model handler', async () => {
  const gw = await bootGateway();
  try {
    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.map((m) => m.id).sort(),
      ['deepseek-v4-flash-vision-exp', 'qwen3.8-flash']
    );
  } finally {
    gw.kill();
  }
});
