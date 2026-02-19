import type { RNPlugin } from '@remnote/plugin-sdk';
import { ERROR_TOAST_COOLDOWN_MS } from './constants';
import type { UserFacingError } from './errors';

const lastToastAtByKey = new Map<string, number>();

function shouldShowToast(key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const lastAt = lastToastAtByKey.get(key) ?? 0;
  if (now - lastAt < cooldownMs) {
    return false;
  }
  lastToastAtByKey.set(key, now);
  return true;
}

export async function notifyError(
  plugin: RNPlugin,
  userError: UserFacingError,
  options?: {
    scope?: string;
    toast?: boolean;
    cooldownMs?: number;
    force?: boolean;
  },
): Promise<void> {
  const scope = options?.scope ?? 'general';
  const toast = options?.toast ?? true;
  const cooldownMs = options?.cooldownMs ?? ERROR_TOAST_COOLDOWN_MS;
  const key = `${scope}:${userError.code}`;

  console.error('[pagesync][error]', {
    code: userError.code,
    severity: userError.severity,
    scope,
    details: userError.details,
  });

  if (!toast) {
    return;
  }

  if (!options?.force && !shouldShowToast(key, cooldownMs)) {
    return;
  }

  await plugin.app.toast(`${userError.message} (${userError.code})`);
}
