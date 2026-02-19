import type { RNPlugin } from '@remnote/plugin-sdk';
import {
  DEFAULT_INACTIVITY_HOURS,
  DEFAULT_SERVER_HTTP_URL,
  DEFAULT_SERVER_WS_URL,
  STORAGE_KEYS,
  type DeviceMode,
} from './constants';

export type DeviceConfig = {
  mode: DeviceMode;
  autoStart: boolean;
  serverHttpUrl: string;
  serverWsUrl: string;
  inactivityHours: number;
  deviceId: string;
  debugLogs: boolean;
};

function makeDeviceId() {
  return `pagesync-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export async function ensureDeviceId(plugin: RNPlugin): Promise<string> {
  const existing = await plugin.storage.getLocal<string>(STORAGE_KEYS.deviceId);
  if (existing) {
    return existing;
  }
  const created = makeDeviceId();
  await plugin.storage.setLocal(STORAGE_KEYS.deviceId, created);
  return created;
}

export async function loadDeviceConfig(plugin: RNPlugin): Promise<DeviceConfig> {
  const deviceId = await ensureDeviceId(plugin);

  const mode = (await plugin.storage.getLocal<DeviceMode>(STORAGE_KEYS.mode)) ?? 'client';
  const autoStart = (await plugin.storage.getLocal<boolean>(STORAGE_KEYS.autoStart)) ?? false;
  const serverHttpUrl =
    (await plugin.storage.getLocal<string>(STORAGE_KEYS.serverHttpUrl)) ?? DEFAULT_SERVER_HTTP_URL;
  const serverWsUrl =
    (await plugin.storage.getLocal<string>(STORAGE_KEYS.serverWsUrl)) ?? DEFAULT_SERVER_WS_URL;

  const inactivityHours =
    (await plugin.storage.getLocal<number>(STORAGE_KEYS.inactivityHours)) ??
    DEFAULT_INACTIVITY_HOURS;
  const debugLogs = (await plugin.storage.getLocal<boolean>(STORAGE_KEYS.debugLogs)) ?? false;

  return {
    mode,
    autoStart,
    serverHttpUrl,
    serverWsUrl,
    inactivityHours,
    deviceId,
    debugLogs,
  };
}

export async function saveDeviceConfig(
  plugin: RNPlugin,
  patch: Partial<Omit<DeviceConfig, 'deviceId'>>,
): Promise<DeviceConfig> {
  if (patch.mode) {
    await plugin.storage.setLocal(STORAGE_KEYS.mode, patch.mode);
  }
  if (patch.autoStart !== undefined) {
    await plugin.storage.setLocal(STORAGE_KEYS.autoStart, patch.autoStart);
  }
  if (patch.serverHttpUrl !== undefined) {
    await plugin.storage.setLocal(STORAGE_KEYS.serverHttpUrl, patch.serverHttpUrl);
  }
  if (patch.serverWsUrl !== undefined) {
    await plugin.storage.setLocal(STORAGE_KEYS.serverWsUrl, patch.serverWsUrl);
  }
  if (patch.inactivityHours !== undefined) {
    await plugin.storage.setLocal(STORAGE_KEYS.inactivityHours, patch.inactivityHours);
  }
  if (patch.debugLogs !== undefined) {
    await plugin.storage.setLocal(STORAGE_KEYS.debugLogs, patch.debugLogs);
  }

  return loadDeviceConfig(plugin);
}
