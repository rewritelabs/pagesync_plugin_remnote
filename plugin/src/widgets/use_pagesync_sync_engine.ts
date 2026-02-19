import {
  AppEvents,
  useAPIEventListener,
  usePlugin,
  type RNPlugin,
  type Rem,
} from '@remnote/plugin-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  API_PATHS,
  INVALID_WS_PAYLOAD_THRESHOLD,
  INVALID_WS_PAYLOAD_WINDOW_MS,
  LOCAL_NAV_DEBOUNCE_MS,
  REMOTE_NAV_SUPPRESSION_MS,
  WS_RECONNECT_BASE_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  type ClientRuntimeState,
  type PageUpdateMessage,
  type ServerState,
  type SyncStrength,
} from '../constants';
import { loadDeviceConfig, type DeviceConfig } from '../deviceConfig';
import { errorDetails, normalizeError } from '../errors';
import { notifyError } from '../notify';

function isPageUpdateMessage(value: unknown): value is PageUpdateMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'page_update' &&
    typeof candidate.remId === 'string' &&
    (candidate.strength === 'strong' || candidate.strength === 'weak')
  );
}

function isSettingsSavedMessage(value: unknown): boolean {
  const payload =
    value && typeof value === 'object' && 'message' in value
      ? (value as { message: unknown }).message
      : value;

  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as Record<string, unknown>).type === 'settings_saved'
  );
}

function isSyncTriggerMessage(value: unknown): boolean {
  const payload =
    value && typeof value === 'object' && 'message' in value
      ? (value as { message: unknown }).message
      : value;

  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as Record<string, unknown>).type === 'pagesync_sync_trigger'
  );
}

function normalizeHttpUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function normalizeWsUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

async function getCurrentRemId(plugin: RNPlugin): Promise<string | null> {
  const paneId = await plugin.window.getFocusedPaneId();
  if (!paneId) {
    return null;
  }
  return (await plugin.window.getOpenPaneRemId(paneId)) ?? null;
}

async function openRemById(plugin: RNPlugin, remId: string) {
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

type ConnectionState = 'inactive' | 'connecting' | 'connected' | 'degraded';

type StopReason = 'manual' | 'inactive' | 'error';

export type PageSyncEngine = {
  config: DeviceConfig | null;
  isActive: boolean;
  connectionState: ConnectionState;
  onPressSync: () => Promise<void>;
  onPressResync: () => Promise<void>;
  onStop: () => Promise<void>;
  onOpenSettings: () => Promise<void>;
};

export function usePageSyncEngine(): PageSyncEngine {
  const plugin = usePlugin();

  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const [runtimeState, setRuntimeState] = useState<ClientRuntimeState>('off');
  const [connectionState, setConnectionState] = useState<ConnectionState>('inactive');

  const configRef = useRef<DeviceConfig | null>(null);
  const runtimeStateRef = useRef<ClientRuntimeState>('off');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectGenerationRef = useRef(0);
  const inactivityTimerRef = useRef<number | null>(null);
  const isApplyingRemoteNavRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const lastNavRef = useRef<{ remId: string | null; at: number }>({ remId: null, at: 0 });
  const invalidPayloadTimestampsRef = useRef<number[]>([]);

  useEffect(() => {
    runtimeStateRef.current = runtimeState;
  }, [runtimeState]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current !== null) {
      window.clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      } catch {
        // Best-effort close.
      }
      wsRef.current = null;
    }
  }, []);

  const scheduleClientReconnect = useCallback(() => {
    const latestConfig = configRef.current;
    if (
      latestConfig?.mode !== 'client' ||
      runtimeStateRef.current === 'off' ||
      reconnectTimerRef.current !== null
    ) {
      return;
    }

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(WS_RECONNECT_MAX_DELAY_MS, WS_RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    reconnectAttemptRef.current += 1;
    setConnectionState('connecting');

    const generation = reconnectGenerationRef.current;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (generation !== reconnectGenerationRef.current) {
        return;
      }
      void connectWebSocket(generation);
    }, delay);
  }, []);

  const stopSync = useCallback(
    async (reason: StopReason) => {
      clearReconnect();
      clearInactivityTimer();
      closeSocket();
      reconnectGenerationRef.current += 1;
      setRuntimeState('off');
      setConnectionState('inactive');
      reconnectAttemptRef.current = 0;
      invalidPayloadTimestampsRef.current = [];

      if (reason === 'inactive') {
        await plugin.app.toast('Page sync stopped after inactivity timeout.');
      }
    },
    [clearInactivityTimer, clearReconnect, closeSocket, plugin.app],
  );

  const refreshConfig = useCallback(async () => {
    const loaded = await loadDeviceConfig(plugin);
    setConfig(loaded);
    return loaded;
  }, [plugin]);

  const sendUpdate = useCallback(
    async (strength: SyncStrength, remIdOverride?: string) => {
      const cfg = configRef.current;
      if (!cfg) {
        return;
      }

      const remId = remIdOverride ?? (await getCurrentRemId(plugin));
      if (!remId) {
        return;
      }

      const response = await fetch(`${normalizeHttpUrl(cfg.serverHttpUrl)}${API_PATHS.update}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remId,
          strength,
          sourceClientId: cfg.deviceId,
          sentAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(await getHttpErrorDetails(response));
      }

      if (cfg.mode === 'host' && runtimeStateRef.current !== 'off') {
        setConnectionState('connected');
      }
    },
    [plugin],
  );

  const applyRemoteNavigation = useCallback(
    async (remId: string) => {
      try {
        isApplyingRemoteNavRef.current = true;
        await openRemById(plugin, remId);
      } finally {
        window.setTimeout(() => {
          isApplyingRemoteNavRef.current = false;
        }, REMOTE_NAV_SUPPRESSION_MS);
      }
    },
    [plugin],
  );

  const handleServerUpdate = useCallback(
    async (payload: PageUpdateMessage) => {
      if (runtimeStateRef.current === 'off') {
        return;
      }

      const cfg = configRef.current;
      if (!cfg || cfg.mode !== 'client') {
        return;
      }

      if (runtimeStateRef.current === 'idle' && payload.strength === 'weak') {
        return;
      }

      try {
        await applyRemoteNavigation(payload.remId);
        if (runtimeStateRef.current === 'idle' && payload.strength === 'strong') {
          setRuntimeState('sync');
        }
      } catch (error) {
        await notifyError(
          plugin,
          normalizeError({
            code: 'E_NAV_REMOTE_OPEN',
            error,
            details: `remId=${payload.remId} | ${errorDetails(error)}`,
          }),
          { scope: 'client' },
        );
      }
    },
    [applyRemoteNavigation, plugin],
  );

  const connectWebSocket = useCallback(async (expectedGeneration?: number) => {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== reconnectGenerationRef.current
    ) {
      return;
    }

    const cfg = configRef.current;
    if (!cfg) {
      return;
    }

    clearReconnect();
    closeSocket();
    setConnectionState('connecting');

    const wsUrl = normalizeWsUrl(cfg.serverWsUrl);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      setConnectionState('degraded');
      await notifyError(
        plugin,
        normalizeError({
          code: 'E_WS_OPEN',
          error,
          details: `wsUrl=${wsUrl} | ${errorDetails(error)}`,
        }),
        { scope: 'client' },
      );
      scheduleClientReconnect();
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      invalidPayloadTimestampsRef.current = [];
      setConnectionState('connected');
    };

    ws.onmessage = async (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as unknown;
        if (isPageUpdateMessage(parsed)) {
          await handleServerUpdate(parsed);
          return;
        }

        const now = Date.now();
        invalidPayloadTimestampsRef.current = invalidPayloadTimestampsRef.current
          .filter((timestamp) => now - timestamp <= INVALID_WS_PAYLOAD_WINDOW_MS)
          .concat(now);

        await notifyError(
          plugin,
          normalizeError({
            code: 'E_INVALID_WS_PAYLOAD',
            details: `payload=${String(event.data)}`,
          }),
          { scope: 'client', toast: false },
        );

        if (invalidPayloadTimestampsRef.current.length >= INVALID_WS_PAYLOAD_THRESHOLD) {
          setConnectionState('degraded');
        }
      } catch (error) {
        const now = Date.now();
        invalidPayloadTimestampsRef.current = invalidPayloadTimestampsRef.current
          .filter((timestamp) => now - timestamp <= INVALID_WS_PAYLOAD_WINDOW_MS)
          .concat(now);

        await notifyError(
          plugin,
          normalizeError({
            code: 'E_INVALID_WS_PAYLOAD',
            error,
          }),
          { scope: 'client', toast: false },
        );

        if (invalidPayloadTimestampsRef.current.length >= INVALID_WS_PAYLOAD_THRESHOLD) {
          setConnectionState('degraded');
        }
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (runtimeStateRef.current !== 'off') {
        setConnectionState('connecting');
      }
      scheduleClientReconnect();
    };

    ws.onerror = async () => {
      setConnectionState('degraded');
      await notifyError(
        plugin,
        normalizeError({
          code: 'E_WS_RUNTIME',
          details: `wsUrl=${wsUrl} | readyState=${ws.readyState}`,
        }),
        { scope: 'client' },
      );
    };
  }, [clearReconnect, closeSocket, handleServerUpdate, plugin, scheduleClientReconnect]);

  const fetchServerState = useCallback(async (): Promise<ServerState> => {
    const cfg = configRef.current;
    if (!cfg) {
      throw new Error('Missing config');
    }

    const response = await fetch(`${normalizeHttpUrl(cfg.serverHttpUrl)}${API_PATHS.state}`);
    if (!response.ok) {
      throw new Error(await getHttpErrorDetails(response));
    }

    const parsed = (await response.json()) as ServerState;
    return parsed;
  }, []);

  const resetInactivityTimer = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg || cfg.mode !== 'host') {
      return;
    }
    clearInactivityTimer();
    inactivityTimerRef.current = window.setTimeout(
      () => {
        void stopSync('inactive');
      },
      Math.max(1, cfg.inactivityHours) * 60 * 60 * 1000,
    );
  }, [clearInactivityTimer, stopSync]);

  const handleLocalNavigation = useCallback(
    async (remId: string | null) => {
      const cfg = configRef.current;
      if (!cfg) {
        return;
      }

      const now = Date.now();
      if (
        remId &&
        lastNavRef.current.remId === remId &&
        now - lastNavRef.current.at < LOCAL_NAV_DEBOUNCE_MS
      ) {
        return;
      }
      lastNavRef.current = { remId, at: now };

      if (runtimeStateRef.current === 'off') {
        return;
      }

      if (cfg.mode === 'host') {
        if (!remId) {
          return;
        }

        try {
          await sendUpdate('weak', remId);
          resetInactivityTimer();
        } catch (error) {
          setConnectionState('degraded');
          await notifyError(
            plugin,
            normalizeError({
              code: 'E_UPDATE_POST',
              error,
              details: `remId=${remId} | ${errorDetails(error)}`,
            }),
            { scope: 'host' },
          );
        }
        return;
      }

      if (
        cfg.mode === 'client' &&
        runtimeStateRef.current === 'sync' &&
        !isApplyingRemoteNavRef.current
      ) {
        setRuntimeState('idle');
      }
    },
    [plugin, resetInactivityTimer, sendUpdate],
  );

  const onGlobalOpenRem = useCallback(
    async (args: unknown) => {
      const fromArgs =
        args && typeof args === 'object' && 'remId' in (args as Record<string, unknown>)
          ? ((args as Record<string, unknown>).remId as string | null)
          : null;
      const remId = fromArgs ?? (await getCurrentRemId(plugin));
      await handleLocalNavigation(remId);
    },
    [handleLocalNavigation, plugin],
  );

  useAPIEventListener(AppEvents.GlobalOpenRem, undefined, (args) => {
    void onGlobalOpenRem(args);
  });

  useAPIEventListener(AppEvents.MessageBroadcast, undefined, (args) => {
    if (isSettingsSavedMessage(args)) {
      void refreshConfig();
      return;
    }

    if (isSyncTriggerMessage(args)) {
      if (runtimeStateRef.current === 'off') {
        void onPressSync();
      } else {
        void onPressResync();
      }
    }
  });

  const startHostSync = useCallback(async () => {
    setRuntimeState('sync');
    setConnectionState('connecting');

    try {
      await sendUpdate('strong');
      resetInactivityTimer();
    } catch (error) {
      await notifyError(
        plugin,
        normalizeError({
          code: 'E_UPDATE_POST',
          error,
          details: `initial_strong | ${errorDetails(error)}`,
        }),
        { scope: 'host', force: true },
      );
      await stopSync('error');
    }
  }, [plugin, resetInactivityTimer, sendUpdate, stopSync]);

  const startClientSync = useCallback(async () => {
    setRuntimeState('sync');
    setConnectionState('connecting');
    reconnectGenerationRef.current += 1;
    const generation = reconnectGenerationRef.current;

    try {
      const state = await fetchServerState();
      if (state.remId) {
        try {
          await applyRemoteNavigation(state.remId);
        } catch (error) {
          await notifyError(
            plugin,
            normalizeError({
              code: 'E_NAV_REMOTE_OPEN',
              error,
              details: `initial_state_remId=${state.remId} | ${errorDetails(error)}`,
            }),
            { scope: 'client' },
          );
        }
      }

      await connectWebSocket(generation);
    } catch (error) {
      await notifyError(
        plugin,
        normalizeError({
          code: 'E_STATE_FETCH',
          error,
          details: errorDetails(error),
        }),
        { scope: 'client', force: true },
      );
      await stopSync('error');
    }
  }, [applyRemoteNavigation, connectWebSocket, fetchServerState, plugin, stopSync]);

  const onPressSync = useCallback(async () => {
    const cfg = await refreshConfig();
    if (!cfg || runtimeStateRef.current !== 'off') {
      return;
    }

    if (cfg.mode === 'host') {
      await startHostSync();
    } else {
      await startClientSync();
    }
  }, [refreshConfig, startClientSync, startHostSync]);

  const onPressResync = useCallback(async () => {
    const cfg = configRef.current;
    if (!cfg || runtimeStateRef.current === 'off') {
      return;
    }

    if (cfg.mode === 'host') {
      try {
        await sendUpdate('strong');
        resetInactivityTimer();
      } catch (error) {
        setConnectionState('degraded');
        await notifyError(
          plugin,
          normalizeError({
            code: 'E_UPDATE_POST',
            error,
            details: `manual_strong | ${errorDetails(error)}`,
          }),
          { scope: 'host' },
        );
      }
      return;
    }

    try {
      const state = await fetchServerState();
      if (state.remId) {
        await applyRemoteNavigation(state.remId);
        setRuntimeState('sync');
      }
    } catch (error) {
      await notifyError(
        plugin,
        normalizeError({
          code: 'E_STATE_FETCH',
          error,
          details: `manual_resync | ${errorDetails(error)}`,
        }),
        { scope: 'client' },
      );
    }
  }, [applyRemoteNavigation, fetchServerState, plugin, resetInactivityTimer, sendUpdate]);

  const onOpenSettings = useCallback(async () => {
    await plugin.widget.openPopup('settings_popup');
  }, [plugin.widget]);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      const loaded = await loadDeviceConfig(plugin);
      if (!mounted) {
        return;
      }
      setConfig(loaded);
    })();

    return () => {
      mounted = false;
      void stopSync('manual');
    };
  }, [plugin, stopSync]);

  useEffect(() => {
    if (!config || autoStartAttemptedRef.current) {
      return;
    }
    autoStartAttemptedRef.current = true;

    if (config.autoStart && runtimeStateRef.current === 'off') {
      void onPressSync();
    }
  }, [config, onPressSync]);

  return {
    config,
    isActive: runtimeState !== 'off',
    connectionState,
    onPressSync,
    onPressResync,
    onStop: async () => stopSync('manual'),
    onOpenSettings,
  };
}
