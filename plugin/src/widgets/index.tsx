import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { PageSyncRuntime } from '../runtime/pagesync_runtime';
import '../style.css';
import '../App.css';

let runtime: PageSyncRuntime | null = null;

async function onActivate(plugin: ReactRNPlugin) {
  runtime = new PageSyncRuntime(plugin);
  await runtime.init();

  await plugin.app.registerWidget('pagesync_controls', WidgetLocation.SidebarEnd, {
    dimensions: { height: 'auto', width: '100%' },
  });

  await plugin.app.registerWidget('settings_popup', WidgetLocation.Popup, {
    dimensions: { width: '100%', height: 'auto' },
  });

  await plugin.app.registerCommand({
    id: 'pagesync.sync-page',
    name: 'Sync Page',
    description: 'Trigger PageSync. Starts sync when off, or sends a sync-now when active.',
    keywords: 'pagesync sync page remnote',
    quickCode: 'sync page',
    keyboardShortcut: 'mod+alt+s',
    action: async () => {
      if (!runtime) {
        return;
      }
      if (runtime.isActive()) {
        await runtime.syncNow();
      } else {
        await runtime.start();
      }
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {
  if (!runtime) {
    return;
  }
  await runtime.dispose();
  runtime = null;
}

declareIndexPlugin(onActivate, onDeactivate);
