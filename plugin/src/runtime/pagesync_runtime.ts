import { AppEvents, type ReactRNPlugin, type Rem } from '@remnote/plugin-sdk';
import { trackHostSyncAnalytics } from '../analytics';
import {
  API_PATHS,
  INVALID_WS_PAYLOAD_THRESHOLD,
  INVALID_WS_PAYLOAD_WINDOW_MS,
  LOCAL_NAV_DEBOUNCE_MS,
  PAGESYNC_MESSAGE_TYPES,
  REMOTE_NAV_SUPPRESSION_MS,
  WS_RECONNECT_BASE_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  type ClientRuntimeState,
  type ConnectionState,
  type PageSyncRuntimeCommandAction,
  type PageSyncRuntimeCommandMessage,
  type PageSyncRuntimeStatusMessage,
  type PageSyncRuntimeStatusRequestMessage,
  type PageUpdateMessage,
  type ServerState,
  type SyncStrength,
} from '../constants';
import { loadDeviceConfig, type DeviceConfig } from '../deviceConfig';
import { errorDetails, normalizeError } from '../errors';
import { notifyError } from '../notify';

type StopReason = 'manual' | 'inactive' | 'error';

type BroadcastEnvelope = {
  message?: unknown;
};

function normalizeHttpUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function normalizeWsUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function withQueryParam(url: string, key: string, value: string) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function unwrapBroadcastPayload(args: unknown): unknown {
  if (args && typeof args === 'object' && 'message' in (args as BroadcastEnvelope)) {
    return (args as BroadcastEnvelope).message;
  }
  return args;
}

function isPageUpdateMessage(value: unknown): value is PageUpdateMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'page_update' &&
    typeof candidate.remId === 'string' &&
    typeof candidate.userId === 'string' &&
    (candidate.strength === 'strong' || candidate.strength === 'weak')
  );
}

function isWelcomeMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'welcome') {
    return false;
  }
  return candidate.now === undefined || typeof candidate.now === 'string';
}

function isSettingsSavedMessage(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).type === PAGESYNC_MESSAGE_TYPES.settingsSaved
  );
}

function isLegacySyncTriggerMessage(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).type === PAGESYNC_MESSAGE_TYPES.legacySyncTrigger
  );
}

function isRuntimeCommandMessage(value: unknown): value is PageSyncRuntimeCommandMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === PAGESYNC_MESSAGE_TYPES.runtimeCommand &&
    (candidate.action === 'sync_toggle_or_start' ||
      candidate.action === 'sync_now' ||
      candidate.action === 'stop' ||
      candidate.action === 'open_settings')
  );
}

function isRuntimeStatusRequestMessage(value: unknown): value is PageSyncRuntimeStatusRequestMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === PAGESYNC_MESSAGE_TYPES.runtimeStatusRequest &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0
  );
}

async function getCurrentRemId(plugin: ReactRNPlugin): Promise<string | null> {
  const paneId = await plugin.window.getFocusedPaneId();
  if (!paneId) {
    return null;
  }
  return (await plugin.window.getOpenPaneRemId(paneId)) ?? null;
}

async function openRemById(plugin: ReactRNPlugin, remId: string) {
  const rem = (await plugin.rem.findOne(remId)) as Rem | undefined;
  if (!rem) {
    throw new Error(`Rem not found for id: ${remId}`);
  }
  await plugin.window.openRem(rem);
}

async function getHttpErrorDetails(response: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // ignore parse errors
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message = typeof record.error === 'string' ? record.error : undefined;
    if (code && message) {
      return `${code}: ${message}`;
    }
    if (message) {
      return message;
    }
  }

  return `HTTP ${response.status}`;
}

export class PageSyncRuntime {
  private config: DeviceConfig | null = null;
  private runtimeState: ClientRuntimeState = 'off';
  private connectionState: ConnectionState = 'inactive';
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private reconnectGeneration = 0;
  private inactivityTimer: number | null = null;
  private isApplyingRemoteNav = false;
  private autoStartAttempted = false;
  private lastNav: { remId: string | null; at: number } = { remId: null, at: 0 };
  private invalidPayloadTimestamps: number[] = [];
  private disposed = false;

  private readonly onGlobalOpenRemListener = (args: unknown) => {
    void this.onGlobalOpenRem(args);
  };

  private readonly onMessageBroadcastListener = (args: unknown) => {
    void this.onMessageBroadcast(args);
  };

  constructor(private readonly plugin: ReactRNPlugin) {}

  async init(): Promise<void> {
    this.config = await loadDeviceConfig(this.plugin);
    this.broadcastStatus();

    this.plugin.event.addListener(
      AppEvents.GlobalOpenRem,
      undefined,
      this.onGlobalOpenRemListener
    );
    this.plugin.event.addListener(
      AppEvents.MessageBroadcast,
      undefined,
      this.onMessageBroadcastListener
    );

    if (this.config.autoStart && this.runtimeState === 'off' && !this.autoStartAttempted) {
      this.autoStartAttempted = true;
      await this.start();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.plugin.event.removeListener(
      AppEvents.GlobalOpenRem,
      undefined,
      this.onGlobalOpenRemListener
    );
    this.plugin.event.removeListener(
      AppEvents.MessageBroadcast,
      undefined,
      this.onMessageBroadcastListener
    );
    await this.stop('manual');
  }

  isActive(): boolean {
    return this.runtimeState !== 'off';
  }

  getStatusSnapshot(): PageSyncRuntimeStatusMessage {
    return {
      type: PAGESYNC_MESSAGE_TYPES.runtimeStatus,
      runtimeState: this.runtimeState,
      connectionState: this.connectionState,
      mode: this.config?.mode ?? null,
      isActive: this.runtimeState !== 'off',
      updatedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    const cfg = await this.refreshConfig();
    if (!cfg || this.runtimeState !== 'off') {
      return;
    }

    if (cfg.mode === 'host') {
      await this.startHostSync();
    } else {
      await this.startClientSync();
    }
  }

  async syncNow(): Promise<void> {
    const cfg = this.config;
    if (!cfg || this.runtimeState === 'off') {
      await this.start();
      return;
    }

    if (cfg.mode === 'host') {
      try {
        await this.sendUpdate('strong');
        this.resetInactivityTimer();
      } catch (error) {
        this.setConnectionState('degraded');
        await notifyError(
          this.plugin,
          normalizeError({
            code: 'E_UPDATE_POST',
            error,
            details: `manual_strong | ${errorDetails(error)}`,
          }),
          { scope: 'host' }
        );
      }
      return;
    }

    try {
      const state = await this.fetchServerState();
      if (state.remId) {
        await this.applyRemoteNavigation(state.remId);
        this.setRuntimeState('sync');
      }
    } catch (error) {
      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_STATE_FETCH',
          error,
          details: `manual_resync | ${errorDetails(error)}`,
        }),
        { scope: 'client' }
      );
    }
  }

  async stop(reason: StopReason = 'manual'): Promise<void> {
    this.clearReconnect();
    this.clearInactivityTimer();
    this.closeSocket();
    this.reconnectGeneration += 1;
    this.setRuntimeState('off');
    this.setConnectionState('inactive');
    this.reconnectAttempt = 0;
    this.invalidPayloadTimestamps = [];

    if (reason === 'inactive') {
      await this.plugin.app.toast('Page sync stopped after inactivity timeout.');
    }
  }

  async refreshConfig(): Promise<DeviceConfig> {
    const previous = this.config;
    const loaded = await loadDeviceConfig(this.plugin);
    this.config = loaded;
    this.broadcastStatus();

    if (this.runtimeState !== 'off' && previous) {
      const shouldRestart =
        previous.mode !== loaded.mode ||
        previous.serverHttpUrl !== loaded.serverHttpUrl ||
        previous.serverWsUrl !== loaded.serverWsUrl;

      if (shouldRestart) {
        await this.stop('manual');
        await this.start();
      } else if (loaded.mode === 'host') {
        this.resetInactivityTimer();
      }
    }

    return loaded;
  }

  async openSettings(): Promise<void> {
    await this.plugin.widget.openPopup('settings_popup');
  }

  private setRuntimeState(next: ClientRuntimeState) {
    if (this.runtimeState === next) {
      return;
    }
    this.runtimeState = next;
    this.broadcastStatus();
  }

  private setConnectionState(next: ConnectionState) {
    if (this.connectionState === next) {
      return;
    }
    this.connectionState = next;
    this.broadcastStatus();
  }

  private async broadcastStatus(requestId?: string) {
    if (this.disposed) {
      return;
    }
    const status = this.getStatusSnapshot();
    if (requestId) {
      status.requestId = requestId;
    }
    await this.plugin.messaging.broadcast(status);
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearInactivityTimer() {
    if (this.inactivityTimer !== null) {
      window.clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private closeSocket() {
    if (!this.ws) {
      return;
    }

    try {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.close();
    } catch {
      // Best-effort close.
    }
    this.ws = null;
  }

  private scheduleClientReconnect() {
    if (this.config?.mode !== 'client' || this.runtimeState === 'off' || this.reconnectTimer !== null) {
      return;
    }

    const attempt = this.reconnectAttempt;
    const delay = Math.min(WS_RECONNECT_MAX_DELAY_MS, WS_RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    this.reconnectAttempt += 1;
    this.setConnectionState('connecting');

    const generation = this.reconnectGeneration;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.reconnectGeneration || this.disposed) {
        return;
      }
      void this.connectWebSocket(generation);
    }, delay);
  }

  private async sendUpdate(strength: SyncStrength, remIdOverride?: string) {
    if (!this.config) {
      return;
    }

    const remId = remIdOverride ?? (await getCurrentRemId(this.plugin));
    if (!remId) {
      return;
    }

    const response = await fetch(`${normalizeHttpUrl(this.config.serverHttpUrl)}${API_PATHS.update}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remId,
        strength,
        userId: this.config.userId,
        sourceClientId: this.config.deviceId,
        sentAt: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(await getHttpErrorDetails(response));
    }

    if (this.config.mode === 'host' && this.runtimeState !== 'off') {
      this.setConnectionState('connected');
    }
  }

  private async applyRemoteNavigation(remId: string) {
    try {
      this.isApplyingRemoteNav = true;
      await openRemById(this.plugin, remId);
    } finally {
      window.setTimeout(() => {
        this.isApplyingRemoteNav = false;
      }, REMOTE_NAV_SUPPRESSION_MS);
    }
  }

  private async handleServerUpdate(payload: PageUpdateMessage) {
    if (this.runtimeState === 'off') {
      return;
    }

    if (!this.config || this.config.mode !== 'client') {
      return;
    }

    if (payload.userId !== this.config.userId) {
      console.warn('[pagesync] Ignoring page_update for mismatched userId', {
        expectedUserId: this.config.userId,
        payloadUserId: payload.userId,
        remId: payload.remId,
      });
      return;
    }

    if (this.runtimeState === 'idle' && payload.strength === 'weak') {
      return;
    }

    try {
      await this.applyRemoteNavigation(payload.remId);
      if (this.runtimeState === 'idle' && payload.strength === 'strong') {
        this.setRuntimeState('sync');
      }
    } catch (error) {
      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_NAV_REMOTE_OPEN',
          error,
          details: `remId=${payload.remId} | ${errorDetails(error)}`,
        }),
        { scope: 'client' }
      );
    }
  }

  private async connectWebSocket(expectedGeneration?: number) {
    if (expectedGeneration !== undefined && expectedGeneration !== this.reconnectGeneration) {
      return;
    }

    if (!this.config) {
      return;
    }

    this.clearReconnect();
    this.closeSocket();
    this.setConnectionState('connecting');

    const wsUrl = withQueryParam(normalizeWsUrl(this.config.serverWsUrl), 'userId', this.config.userId);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      this.setConnectionState('degraded');
      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_WS_OPEN',
          error,
          details: `wsUrl=${wsUrl} | ${errorDetails(error)}`,
        }),
        { scope: 'client' }
      );
      this.scheduleClientReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.invalidPayloadTimestamps = [];
      this.setConnectionState('connected');
    };

    ws.onmessage = (event) => {
      void this.onWebSocketMessage(event.data);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.runtimeState !== 'off') {
        this.setConnectionState('connecting');
      }
      this.scheduleClientReconnect();
    };

    ws.onerror = () => {
      void notifyError(
        this.plugin,
        normalizeError({
          code: 'E_WS_RUNTIME',
          details: `wsUrl=${wsUrl} | readyState=${ws.readyState}`,
        }),
        { scope: 'client' }
      );
      this.setConnectionState('degraded');
    };
  }

  private async onWebSocketMessage(rawData: unknown) {
    try {
      const parsed = JSON.parse(rawData as string) as unknown;
      if (isPageUpdateMessage(parsed)) {
        await this.handleServerUpdate(parsed);
        return;
      }
      if (isWelcomeMessage(parsed)) {
        return;
      }

      const now = Date.now();
      this.invalidPayloadTimestamps = this.invalidPayloadTimestamps
        .filter((timestamp) => now - timestamp <= INVALID_WS_PAYLOAD_WINDOW_MS)
        .concat(now);

      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_INVALID_WS_PAYLOAD',
          details: `payload=${String(rawData)}`,
        }),
        { scope: 'client', toast: false }
      );

      if (this.invalidPayloadTimestamps.length >= INVALID_WS_PAYLOAD_THRESHOLD) {
        this.setConnectionState('degraded');
      }
    } catch (error) {
      const now = Date.now();
      this.invalidPayloadTimestamps = this.invalidPayloadTimestamps
        .filter((timestamp) => now - timestamp <= INVALID_WS_PAYLOAD_WINDOW_MS)
        .concat(now);

      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_INVALID_WS_PAYLOAD',
          error,
        }),
        { scope: 'client', toast: false }
      );

      if (this.invalidPayloadTimestamps.length >= INVALID_WS_PAYLOAD_THRESHOLD) {
        this.setConnectionState('degraded');
      }
    }
  }

  private async fetchServerState(): Promise<ServerState> {
    if (!this.config) {
      throw new Error('Missing config');
    }

    const stateUrl = withQueryParam(
      `${normalizeHttpUrl(this.config.serverHttpUrl)}${API_PATHS.state}`,
      'userId',
      this.config.userId
    );
    const response = await fetch(stateUrl);
    if (!response.ok) {
      throw new Error(await getHttpErrorDetails(response));
    }

    return (await response.json()) as ServerState;
  }

  private resetInactivityTimer() {
    if (!this.config || this.config.mode !== 'host') {
      return;
    }

    this.clearInactivityTimer();
    this.inactivityTimer = window.setTimeout(() => {
      void this.stop('inactive');
    }, Math.max(1, this.config.inactivityHours) * 60 * 60 * 1000);
  }

  private async handleLocalNavigation(remId: string | null) {
    if (!this.config) {
      return;
    }

    const now = Date.now();
    if (remId && this.lastNav.remId === remId && now - this.lastNav.at < LOCAL_NAV_DEBOUNCE_MS) {
      return;
    }
    this.lastNav = { remId, at: now };

    if (this.runtimeState === 'off') {
      return;
    }

    if (this.config.mode === 'host') {
      if (!remId) {
        return;
      }

      try {
        await this.sendUpdate('weak', remId);
        this.resetInactivityTimer();
      } catch (error) {
        this.setConnectionState('degraded');
        await notifyError(
          this.plugin,
          normalizeError({
            code: 'E_UPDATE_POST',
            error,
            details: `remId=${remId} | ${errorDetails(error)}`,
          }),
          { scope: 'host' }
        );
      }
      return;
    }

    if (this.config.mode === 'client' && this.runtimeState === 'sync' && !this.isApplyingRemoteNav) {
      this.setRuntimeState('idle');
    }
  }

  private async onGlobalOpenRem(args: unknown) {
    const fromArgs =
      args && typeof args === 'object' && 'remId' in (args as Record<string, unknown>)
        ? ((args as Record<string, unknown>).remId as string | null)
        : null;
    const remId = fromArgs ?? (await getCurrentRemId(this.plugin));
    await this.handleLocalNavigation(remId);
  }

  private async startHostSync() {
    this.setRuntimeState('sync');
    this.setConnectionState('connecting');

    try {
      await trackHostSyncAnalytics(this.plugin);
    } catch {
      // analytics failures should not block sync
    }

    try {
      await this.sendUpdate('strong');
      this.resetInactivityTimer();
    } catch (error) {
      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_UPDATE_POST',
          error,
          details: `initial_strong | ${errorDetails(error)}`,
        }),
        { scope: 'host', force: true }
      );
      await this.stop('error');
    }
  }

  private async startClientSync() {
    this.setRuntimeState('sync');
    this.setConnectionState('connecting');
    this.reconnectGeneration += 1;
    const generation = this.reconnectGeneration;

    try {
      const state = await this.fetchServerState();
      if (state.remId) {
        try {
          await this.applyRemoteNavigation(state.remId);
        } catch (error) {
          await notifyError(
            this.plugin,
            normalizeError({
              code: 'E_NAV_REMOTE_OPEN',
              error,
              details: `initial_state_remId=${state.remId} | ${errorDetails(error)}`,
            }),
            { scope: 'client' }
          );
        }
      }

      await this.connectWebSocket(generation);
    } catch (error) {
      await notifyError(
        this.plugin,
        normalizeError({
          code: 'E_STATE_FETCH',
          error,
          details: errorDetails(error),
        }),
        { scope: 'client', force: true }
      );
      await this.stop('error');
    }
  }

  private async handleRuntimeCommand(action: PageSyncRuntimeCommandAction) {
    if (action === 'open_settings') {
      await this.openSettings();
      return;
    }

    if (action === 'stop') {
      await this.stop('manual');
      return;
    }

    if (action === 'sync_now') {
      await this.syncNow();
      return;
    }

    if (this.runtimeState === 'off') {
      await this.start();
      return;
    }

    await this.syncNow();
  }

  private async onMessageBroadcast(args: unknown) {
    const payload = unwrapBroadcastPayload(args);

    if (isSettingsSavedMessage(payload)) {
      await this.refreshConfig();
      return;
    }

    if (isLegacySyncTriggerMessage(payload)) {
      if (this.runtimeState === 'off') {
        await this.start();
      } else {
        await this.syncNow();
      }
      return;
    }

    if (isRuntimeStatusRequestMessage(payload)) {
      await this.broadcastStatus(payload.requestId);
      return;
    }

    if (isRuntimeCommandMessage(payload)) {
      await this.handleRuntimeCommand(payload.action);
    }
  }
}
