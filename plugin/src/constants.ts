export type SyncStrength = 'strong' | 'weak';
export type DeviceMode = 'host' | 'client';
export type ClientRuntimeState = 'off' | 'sync' | 'idle';

export const DEFAULT_SERVER_HTTP_URL = 'https://vps1.jakobg.dev/remnotepagesync/';
export const DEFAULT_SERVER_WS_URL = 'wss://vps1.jakobg.dev/remnotepagesync/ws';
export const DEFAULT_INACTIVITY_HOURS = 3;

export const STORAGE_KEYS = {
  mode: 'pagesync.mode',
  autoStart: 'pagesync.autoStart',
  serverHttpUrl: 'pagesync.serverHttpUrl',
  serverWsUrl: 'pagesync.serverWsUrl',
  inactivityHours: 'pagesync.inactivityHours',
  deviceId: 'pagesync.deviceId',
  debugLogs: 'pagesync.debugLogs',
} as const;

export const API_PATHS = {
  health: '/health',
  state: '/state',
  update: '/update',
} as const;

export const LOCAL_NAV_DEBOUNCE_MS = 250;
export const REMOTE_NAV_SUPPRESSION_MS = 600;
export const WS_RECONNECT_MAX_DELAY_MS = 8000;
export const WS_RECONNECT_BASE_DELAY_MS = 500;
export const ERROR_TOAST_COOLDOWN_MS = 10000;
export const INVALID_WS_PAYLOAD_THRESHOLD = 3;
export const INVALID_WS_PAYLOAD_WINDOW_MS = 30000;

export type ServerState = {
  remId: string | null;
  strength: SyncStrength | null;
  updatedAt: string | null;
  sourceClientId: string | null;
};

export type PageUpdateMessage = {
  type: 'page_update';
  remId: string;
  strength: SyncStrength;
  updatedAt: string;
  sourceClientId: string;
};
