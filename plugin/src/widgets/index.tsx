import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

async function onActivate(plugin: ReactRNPlugin) {
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
      await plugin.messaging.broadcast({
        type: 'pagesync_sync_trigger',
        at: Date.now(),
      });
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
