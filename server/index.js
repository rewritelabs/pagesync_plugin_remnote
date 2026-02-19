const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 9091);
const MAX_BODY_BYTES = 1_000_000;
const INACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 128;
const ALLOWED_UPDATE_KEYS = new Set(['remId', 'strength', 'sourceClientId', 'sentAt']);

function makeEmptyState() {
  return {
    remId: null,
    strength: null,
    updatedAt: null,
    sourceClientId: null,
  };
}

const latestState = makeEmptyState();
let latestStateLastTouchedAt = null;
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

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { ok: false, error: message, code });
}

function makeCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && SAFE_ID_REGEX.test(value);
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
      sourceClientId: payload.sourceClientId,
      sentAt: payload.sentAt,
    },
  };
}

function clearLatestState(reason) {
  latestState.remId = null;
  latestState.strength = null;
  latestState.updatedAt = null;
  latestState.sourceClientId = null;
  latestStateLastTouchedAt = null;
  metrics.memoryLatestStateClearedTotal += 1;
  log('memory.latest_state.cleared', { reason });
}

function isLatestStateExpired(now = Date.now()) {
  if (latestStateLastTouchedAt === null) {
    return false;
  }
  return now - latestStateLastTouchedAt > INACTIVITY_TTL_MS;
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

  if (isLatestStateExpired(now)) {
    clearLatestState('ttl_expired');
  }
}

function broadcastPageUpdate() {
  if (!latestState.remId || !latestState.strength || !latestState.updatedAt || !latestState.sourceClientId) {
    log('broadcast.skipped', { reason: 'state_incomplete' });
    return;
  }

  const message = JSON.stringify({
    type: 'page_update',
    remId: latestState.remId,
    strength: latestState.strength,
    updatedAt: latestState.updatedAt,
    sourceClientId: latestState.sourceClientId,
  });

  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
      sent += 1;
    }
  }

  log('ws.broadcast.page_update', {
    remId: latestState.remId,
    strength: latestState.strength,
    sourceClientId: latestState.sourceClientId,
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
      latestStateIsEmpty: latestState.remId === null,
      latestStateAgeMs: latestStateLastTouchedAt === null ? null : now - latestStateLastTouchedAt,
    },
    latestState,
  };
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = req.url || '/';
  metrics.httpRequestsTotal += 1;
  log('http.request', { method, url });

  if (method === 'OPTIONS') {
    metrics.httpOptionsRequestsTotal += 1;
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'GET' && url === '/health') {
    metrics.httpHealthRequestsTotal += 1;
    log('http.health.ok');
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (method === 'GET' && url === '/metrics') {
    sendJson(res, 200, getMetricsSnapshot());
    return;
  }

  if (method === 'GET' && url === '/state') {
    metrics.httpStateRequestsTotal += 1;
    cleanupInactiveMemory();
    log('http.state.read', latestState);
    sendJson(res, 200, latestState);
    return;
  }

  if (method === 'POST' && url === '/update') {
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
        sendError(res, 400, validated.code, validated.message);
        return;
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const update = validated.value;

      updateCounter += 1;
      metrics.httpUpdateAcceptedTotal += 1;
      latestState.remId = update.remId;
      latestState.strength = update.strength;
      latestState.updatedAt = nowIso;
      latestState.sourceClientId = update.sourceClientId;
      latestStateLastTouchedAt = nowMs;

      activeClients.set(update.sourceClientId, {
        lastSeenAt: nowMs,
        lastRemId: update.remId,
        lastStrength: update.strength,
      });

      log('http.update.accepted', {
        seq: updateCounter,
        remId: latestState.remId,
        strength: latestState.strength,
        sourceClientId: latestState.sourceClientId,
      });

      broadcastPageUpdate();
      sendJson(res, 200, { ok: true, state: latestState });
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
      sendError(res, statusCode, code, message);
    }
    return;
  }

  metrics.httpNotFoundTotal += 1;
  log('http.not_found', { method, url });
  sendError(res, 404, 'E_NOT_FOUND', 'Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.add(ws);
  metrics.wsConnectionsTotal += 1;
  log('ws.connect', { clients: clients.size });

  ws.send(
    JSON.stringify({
      type: 'welcome',
      now: new Date().toISOString(),
    }),
  );

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    clients.delete(ws);
    log('ws.close', { clients: clients.size });
  });

  ws.on('error', (error) => {
    metrics.wsErrorsTotal += 1;
    log('ws.error', {
      error: error instanceof Error ? error.message : String(error),
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
      log('ws.terminated_stale', { clients: clients.size });
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
