import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamUrl, resolveAdapter, applyAdapterAuth } from '../lib/adapters.js';

test('buildUpstreamUrl preserves baseUrl path and deduplicates /v1', () => {
  assert.equal(
    buildUpstreamUrl('/v1/chat/completions', '', 'https://api.cerebras.ai/v1', '').href,
    'https://api.cerebras.ai/v1/chat/completions'
  );

  assert.equal(
    buildUpstreamUrl('/v1/chat/completions', '', 'https://api.groq.com/openai/v1', '').href,
    'https://api.groq.com/openai/v1/chat/completions'
  );

  assert.equal(
    buildUpstreamUrl('/v1/chat/completions', '', 'https://openrouter.ai/api/v1', '').href,
    'https://openrouter.ai/api/v1/chat/completions'
  );

  assert.equal(
    buildUpstreamUrl('/v1/messages', '', 'https://api.anthropic.com', '').href,
    'https://api.anthropic.com/v1/messages'
  );

  assert.equal(
    buildUpstreamUrl('/messages', '', 'https://api.anthropic.com', '/v1').href,
    'https://api.anthropic.com/v1/messages'
  );

  assert.equal(
    buildUpstreamUrl('/v1/models', '?limit=10', 'https://api.cerebras.ai/v1', '').href,
    'https://api.cerebras.ai/v1/models?limit=10'
  );

  assert.equal(
    buildUpstreamUrl('/v1/chat/completions', '', 'http://127.0.0.1:8080/v1/', '').href,
    'http://127.0.0.1:8080/v1/chat/completions'
  );
});

test('resolveAdapter handles known and custom adapters', () => {
  assert.equal(resolveAdapter('openai').auth, 'bearer');
  assert.equal(resolveAdapter('anthropic').auth, 'x-api-key');
  assert.equal(resolveAdapter({ auth: 'x-api-key', pathPrefix: '/v1' }).pathPrefix, '/v1');
});

test('applyAdapterAuth sets correct headers', () => {
  const h1 = new Headers();
  applyAdapterAuth(h1, 'key-123', { auth: 'bearer' });
  assert.equal(h1.get('authorization'), 'Bearer key-123');

  const h2 = new Headers();
  applyAdapterAuth(h2, 'key-456', { auth: 'x-api-key', extraHeaders: { 'x-version': '1.0' } });
  assert.equal(h2.get('x-api-key'), 'key-456');
  assert.equal(h2.get('x-version'), '1.0');
});
