export type SyncStrength = 'strong' | 'weak';
export type DeviceMode = 'host' | 'client';
export type ClientRuntimeState = 'off' | 'sync' | 'idle';
export type ConnectionState = 'inactive' | 'connecting' | 'connected' | 'degraded';

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
  analyticsMonth: 'pagesync.analyticsMonth',
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

export const PAGESYNC_MESSAGE_TYPES = {
  settingsSaved: 'settings_saved',
  runtimeCommand: 'pagesync_runtime_command',
  runtimeStatusRequest: 'pagesync_runtime_status_request',
  runtimeStatus: 'pagesync_runtime_status',
  legacySyncTrigger: 'pagesync_sync_trigger',
} as const;

export type PageSyncRuntimeCommandAction =
  | 'sync_toggle_or_start'
  | 'sync_now'
  | 'stop'
  | 'open_settings';

export type PageSyncRuntimeCommandMessage = {
  type: typeof PAGESYNC_MESSAGE_TYPES.runtimeCommand;
  action: PageSyncRuntimeCommandAction;
  at: number;
};

export type PageSyncRuntimeStatusRequestMessage = {
  type: typeof PAGESYNC_MESSAGE_TYPES.runtimeStatusRequest;
  requestId: string;
  at: number;
};

export type PageSyncRuntimeStatusMessage = {
  type: typeof PAGESYNC_MESSAGE_TYPES.runtimeStatus;
  requestId?: string;
  runtimeState: ClientRuntimeState;
  connectionState: ConnectionState;
  mode: DeviceMode | null;
  isActive: boolean;
  updatedAt: number;
};
