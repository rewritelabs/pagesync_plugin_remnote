const http = require('http');
const { WebSocketServer } = require('ws');

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readCorsAllowedOrigins() {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw || raw.trim() === '') {
    return ['*'];
  }
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : ['*'];
}

const PORT = readPositiveIntegerEnv('PORT', 9091);
const MAX_BODY_BYTES = 1_000_000;
const INACTIVITY_TTL_MS = readPositiveIntegerEnv('INACTIVITY_TTL_MS', 24 * 60 * 60 * 1000);
const CLEANUP_INTERVAL_MS = readPositiveIntegerEnv('CLEANUP_INTERVAL_MS', 5 * 60 * 1000);
const CORS_ALLOWED_ORIGINS = readCorsAllowedOrigins();
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 128;
const ALLOWED_UPDATE_KEYS = new Set(['remId', 'strength', 'userId', 'sourceClientId', 'sentAt']);

function makeEmptyState() {
  return {
    remId: null,
    strength: null,
    updatedAt: null,
    sourceClientId: null,
  };
}

const latestStateByUserId = new Map();
const latestStateLastTouchedAtByUserId = new Map();
const activeClients = new Map();
const clients = new Set();
let updateCounter = 0;
const startedAtMs = Date.now();
const metrics = {
  httpRequestsTotal: 0,
  httpOptionsRequestsTotal: 0,
  httpHealthRequestsTotal: 0,
  httpStateRequestsTotal: 0,
  httpUpdateRequestsTotal: 0,
  httpUpdateAcceptedTotal: 0,
  httpUpdateRejectedTotal: 0,
  httpNotFoundTotal: 0,
  wsConnectionsTotal: 0,
  wsRejectedInvalidUserTotal: 0,
  wsErrorsTotal: 0,
  wsTerminatedStaleTotal: 0,
  wsBroadcastMessagesTotal: 0,
  wsBroadcastRecipientsTotal: 0,
  memoryClientsPrunedTotal: 0,
  memoryLatestStateClearedTotal: 0,
};

function log(event, details = {}) {
  const stamp = new Date().toISOString();
  console.log(`[pagesync-server] ${stamp} ${event}`, details);
}

function getAllowedOrigin(requestOrigin) {
  if (CORS_ALLOWED_ORIGINS.includes('*')) {
    return '*';
  }
  if (!requestOrigin) {
    return null;
  }
  return CORS_ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : null;
}

function setCorsHeaders(req, res) {
  const requestOrigin = req.headers.origin;
  const allowedOrigin = getAllowedOrigin(requestOrigin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (allowedOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function sendError(req, res, statusCode, code, message) {
  sendJson(req, res, statusCode, { ok: false, error: message, code });
}

function makeCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseRequestUrl(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(makeCodedError('E_BODY_TOO_LARGE', 'Body too large'));
      }
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch {
        reject(makeCodedError('E_INVALID_JSON', 'Invalid JSON body'));
      }
    });
    req.on('error', () => {
      reject(makeCodedError('E_INTERNAL', 'Request stream error'));
    });
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

function isSafeId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_REGEX.test(value)
  );
}

function getUserIdFromUrl(rawUrl) {
  const parsed = parseRequestUrl(rawUrl);
  const userId = parsed.searchParams.get('userId');
  return typeof userId === 'string' ? userId : null;
}

function getStateForUser(userId) {
  return latestStateByUserId.get(userId) ?? makeEmptyState();
}

function validateUpdatePayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, code: 'E_INVALID_PAYLOAD', message: 'Payload must be a plain object' };
  }

  const keys = Object.keys(payload);
  for (const key of keys) {
    if (!ALLOWED_UPDATE_KEYS.has(key)) {
      return { ok: false, code: 'E_INVALID_PAYLOAD', message: `Unknown payload field: ${key}` };
    }
  }

  if (!isSafeId(payload.remId)) {
    return { ok: false, code: 'E_INVALID_FIELD', message: 'Invalid remId' };
  }

  if (payload.strength !== 'strong' && payload.strength !== 'weak') {
    return { ok: false, code: 'E_INVALID_FIELD', message: 'Invalid strength' };
  }

  if (!isSafeId(payload.userId)) {
    return { ok: false, code: 'E_INVALID_FIELD', message: 'Invalid userId' };
  }

  if (!isSafeId(payload.sourceClientId)) {
    return { ok: false, code: 'E_INVALID_FIELD', message: 'Invalid sourceClientId' };
  }

  if (payload.sentAt !== undefined) {
    if (typeof payload.sentAt !== 'string' || Number.isNaN(Date.parse(payload.sentAt))) {
      return { ok: false, code: 'E_INVALID_FIELD', message: 'Invalid sentAt' };
    }
  }

  return {
    ok: true,
    value: {
      remId: payload.remId,
      strength: payload.strength,
      userId: payload.userId,
      sourceClientId: payload.sourceClientId,
      sentAt: payload.sentAt,
    },
  };
}

function clearLatestStateForUser(userId, reason) {
  latestStateByUserId.delete(userId);
  latestStateLastTouchedAtByUserId.delete(userId);
  metrics.memoryLatestStateClearedTotal += 1;
  log('memory.latest_state.cleared', { reason, userId });
}

function cleanupInactiveMemory(now = Date.now()) {
  let removedClients = 0;
  for (const [clientId, activity] of activeClients.entries()) {
    if (now - activity.lastSeenAt > INACTIVITY_TTL_MS) {
      activeClients.delete(clientId);
      removedClients += 1;
    }
  }

  if (removedClients > 0) {
    metrics.memoryClientsPrunedTotal += removedClients;
    log('memory.clients.pruned', {
      removedCount: removedClients,
      remainingCount: activeClients.size,
    });
  }

  for (const [userId, lastTouchedAt] of latestStateLastTouchedAtByUserId.entries()) {
    if (now - lastTouchedAt > INACTIVITY_TTL_MS) {
      clearLatestStateForUser(userId, 'ttl_expired');
    }
  }
}

function broadcastPageUpdate(userId, state) {
  if (!state.remId || !state.strength || !state.updatedAt || !state.sourceClientId) {
    log('broadcast.skipped', { reason: 'state_incomplete', userId });
    return;
  }

  const message = JSON.stringify({
    type: 'page_update',
    remId: state.remId,
    strength: state.strength,
    updatedAt: state.updatedAt,
    userId,
    sourceClientId: state.sourceClientId,
  });

  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && ws.userId === userId) {
      ws.send(message);
      sent += 1;
    }
  }

  log('ws.broadcast.page_update', {
    userId,
    remId: state.remId,
    strength: state.strength,
    sourceClientId: state.sourceClientId,
    recipients: sent,
  });
  metrics.wsBroadcastMessagesTotal += 1;
  metrics.wsBroadcastRecipientsTotal += sent;
}

function getMetricsSnapshot() {
  const now = Date.now();
  return {
    ok: true,
    now: new Date(now).toISOString(),
    uptimeMs: now - startedAtMs,
    counters: metrics,
    gauges: {
      wsClientsConnected: clients.size,
      trackedActiveClients: activeClients.size,
      trackedUsers: latestStateByUserId.size,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const parsedUrl = parseRequestUrl(req.url || '/');
  const pathname = parsedUrl.pathname;
  metrics.httpRequestsTotal += 1;
  log('http.request', { method, url: req.url || '/' });

  if (method === 'OPTIONS') {
    metrics.httpOptionsRequestsTotal += 1;
    setCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'GET' && pathname === '/health') {
    metrics.httpHealthRequestsTotal += 1;
    log('http.health.ok');
    sendJson(req, res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (method === 'GET' && pathname === '/metrics') {
    sendJson(req, res, 200, getMetricsSnapshot());
    return;
  }

  if (method === 'GET' && pathname === '/state') {
    metrics.httpStateRequestsTotal += 1;

    const userId = parsedUrl.searchParams.get('userId');
    if (!isSafeId(userId)) {
      sendError(req, res, 400, 'E_INVALID_QUERY', 'Missing or invalid userId query parameter');
      return;
    }

    cleanupInactiveMemory();
    const state = getStateForUser(userId);
    log('http.state.read', { userId, state });
    sendJson(req, res, 200, state);
    return;
  }

  if (method === 'POST' && pathname === '/update') {
    metrics.httpUpdateRequestsTotal += 1;
    try {
      const payload = await parseRequestBody(req);
      const validated = validateUpdatePayload(payload);
      if (!validated.ok) {
        metrics.httpUpdateRejectedTotal += 1;
        log('http.update.invalid', {
          code: validated.code,
          message: validated.message,
        });
        sendError(req, res, 400, validated.code, validated.message);
        return;
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const update = validated.value;

      const nextState = {
        remId: update.remId,
        strength: update.strength,
        updatedAt: nowIso,
        sourceClientId: update.sourceClientId,
      };

      updateCounter += 1;
      metrics.httpUpdateAcceptedTotal += 1;
      latestStateByUserId.set(update.userId, nextState);
      latestStateLastTouchedAtByUserId.set(update.userId, nowMs);

      activeClients.set(update.sourceClientId, {
        userId: update.userId,
        lastSeenAt: nowMs,
        lastRemId: update.remId,
        lastStrength: update.strength,
      });

      log('http.update.accepted', {
        seq: updateCounter,
        userId: update.userId,
        remId: nextState.remId,
        strength: nextState.strength,
        sourceClientId: nextState.sourceClientId,
      });

      broadcastPageUpdate(update.userId, nextState);
      sendJson(req, res, 200, { ok: true, state: nextState });
    } catch (error) {
      metrics.httpUpdateRejectedTotal += 1;
      const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const code = typeof rawCode === 'string' ? rawCode : 'E_INTERNAL';
      const message = error instanceof Error ? error.message : 'Invalid request body';
      let statusCode = 500;
      if (code === 'E_INVALID_JSON' || code === 'E_INVALID_PAYLOAD' || code === 'E_INVALID_FIELD') {
        statusCode = 400;
      } else if (code === 'E_BODY_TOO_LARGE') {
        statusCode = 413;
      } else if (code === 'E_INTERNAL') {
        statusCode = 500;
      }
      log('http.update.error', {
        error: error instanceof Error ? error.message : String(error),
        code,
      });
      sendError(req, res, statusCode, code, message);
    }
    return;
  }

  metrics.httpNotFoundTotal += 1;
  log('http.not_found', { method, url: req.url || '/' });
  sendError(req, res, 404, 'E_NOT_FOUND', 'Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, request) => {
  const userId = getUserIdFromUrl(request.url || '/');
  if (!isSafeId(userId)) {
    metrics.wsRejectedInvalidUserTotal += 1;
    log('ws.connect.rejected_invalid_user', { url: request.url || '/' });
    ws.close(1008, 'invalid userId');
    return;
  }

  ws.isAlive = true;
  ws.userId = userId;
  clients.add(ws);
  metrics.wsConnectionsTotal += 1;
  log('ws.connect', { clients: clients.size, userId });

  ws.send(
    JSON.stringify({
      type: 'welcome',
      now: new Date().toISOString(),
    })
  );

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    clients.delete(ws);
    log('ws.close', { clients: clients.size, userId: ws.userId });
  });

  ws.on('error', (error) => {
    metrics.wsErrorsTotal += 1;
    log('ws.error', {
      error: error instanceof Error ? error.message : String(error),
      userId: ws.userId,
      clients: clients.size,
    });
  });
});

const wsHealthInterval = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      clients.delete(ws);
      metrics.wsTerminatedStaleTotal += 1;
      log('ws.terminated_stale', { clients: clients.size, userId: ws.userId });
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

const cleanupInterval = setInterval(() => {
  cleanupInactiveMemory();
}, CLEANUP_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(wsHealthInterval);
  clearInterval(cleanupInterval);
});

server.listen(PORT, () => {
  log('server.listen', {
    url: `http://0.0.0.0:${PORT}`,
    inactivityTtlMs: INACTIVITY_TTL_MS,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
  });
});
