import type { RNPlugin } from '@remnote/plugin-sdk';
import { STORAGE_KEYS } from './constants';

const ANALYTICS_ENDPOINT = 'https://rewritelabs.com/helpers/analytics/';
const ANALYTICS_PROJECT = 'pagesync';

function getCurrentYYYYMM(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

async function postAnalyticsEvent(event: 'install' | 'monthly_active'): Promise<void> {
  const response = await fetch(ANALYTICS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project: ANALYTICS_PROJECT,
      event,
    }),
  });

  if (response.ok) {
    return;
  }

  throw new Error(`Analytics request failed with HTTP ${response.status}`);
}

export async function trackHostSyncAnalytics(plugin: RNPlugin): Promise<void> {
  const currentMonth = getCurrentYYYYMM();
  const storedMonth = await plugin.storage.getLocal<string>(STORAGE_KEYS.analyticsMonth);

  if (!storedMonth) {
    await postAnalyticsEvent('install');
    await plugin.storage.setLocal(STORAGE_KEYS.analyticsMonth, currentMonth);
    return;
  }

  if (storedMonth === currentMonth) {
    return;
  }

  await postAnalyticsEvent('monthly_active');
  await plugin.storage.setLocal(STORAGE_KEYS.analyticsMonth, currentMonth);
}
