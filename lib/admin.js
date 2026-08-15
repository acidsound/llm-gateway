import { sendJson, readJsonBody } from './common.js';

/**
 * Handles the admin API:
 *   GET    /admin/routes              -> list routes + available models
 *   PUT    /admin/routes/:model       -> upsert a route (body: "upstream/model" | { upstream, model, fallback? })
 *   DELETE /admin/routes/:model       -> remove a route
 *
 * Requires ADMIN_TOKEN when configured. Returns true when the path is an admin route.
 */
export async function handleAdmin(req, res, reqUrl, { store, adminToken, logger }) {
  const pathname = reqUrl.pathname;
  if (!pathname.startsWith('/admin/routes')) return false;

  if (!isAuthorized(req, reqUrl, adminToken)) {
    send(res, 401, { error: { message: 'Unauthorized', type: 'unauthorized', code: 401 } });
    return true;
  }

  const segments = pathname.split('/').filter(Boolean); // ['admin', 'routes', model?]
  const model = segments[2] ? decodeURIComponent(segments[2]) : null;
  const hasModel = !!model;

  if (req.method === 'GET' && !hasModel) {
    send(res, 200, { models: store.availableModels(), routes: store.list() });
    return true;
  }

  if (req.method === 'PUT' && hasModel) {
    if (model.includes('/')) {
      send(res, 400, { error: { message: 'Model name cannot contain "/"', type: 'invalid_request_error', code: 400 } });
      return true;
    }
    let spec;
    try {
      spec = await readJsonBody(req);
    } catch (err) {
      send(res, 400, { error: { message: err.message, type: 'invalid_request_error', code: 400 } });
      return true;
    }
    try {
      const route = store.set(model, spec);
      const persisted = await store.persist();
      if (!persisted) logger.warn(`route "${model}" updated in memory but could not be persisted`);
      logger.info(`route added/updated: "${model}" -> ${route.upstream}/${route.model}`);
      send(res, 200, { model, route });
    } catch (err) {
      send(res, 400, { error: { message: err.message, type: 'invalid_request_error', code: 400 } });
    }
    return true;
  }

  if (req.method === 'DELETE' && hasModel) {
    const removed = store.delete(model);
    if (removed) {
      const persisted = await store.persist();
      if (!persisted) logger.warn(`route "${model}" removed in memory but could not be persisted`);
      logger.info(`route removed: "${model}"`);
      send(res, 200, { model, removed: true });
    } else {
      send(res, 404, { error: { message: `Route "${model}" not found`, type: 'not_found', code: 404 } });
    }
    return true;
  }

  send(res, 405, { error: { message: 'Method not allowed', type: 'method_not_allowed', code: 405 } });
  return true;
}

export function isAuthorized(req, reqUrl, adminToken) {
  if (!adminToken) return true;
  return req.headers.authorization === `Bearer ${adminToken}` || reqUrl.searchParams.get('token') === adminToken;
}

function send(res, status, body) {
  sendJson(res, status, body);
}
