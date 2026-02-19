import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useCallback, useEffect, useState } from 'react';
import { loadDeviceConfig, saveDeviceConfig, type DeviceConfig } from '../deviceConfig';
import type { DeviceMode } from '../constants';
import { normalizeError, type UserFacingError } from '../errors';
import { notifyError } from '../notify';
import '../style.css';
import '../index.css';

function SettingsPopupWidget() {
  const plugin = usePlugin();
  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const [mode, setMode] = useState<DeviceMode>('client');
  const [autoStart, setAutoStart] = useState(false);
  const [loadError, setLoadError] = useState<UserFacingError | null>(null);
  const [saveError, setSaveError] = useState<UserFacingError | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      setLoadError(null);
      const loaded = await loadDeviceConfig(plugin);
      setConfig(loaded);
      setMode(loaded.mode);
      setAutoStart(loaded.autoStart);
    } catch (error) {
      const normalized = normalizeError({
        code: 'E_SETTINGS_LOAD',
        error,
      });
      setLoadError(normalized);
      await notifyError(plugin, normalized, { scope: 'settings' });
    }
  }, [plugin]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const onSave = async () => {
    try {
      setIsSaving(true);
      setSaveError(null);
      await saveDeviceConfig(plugin, { mode, autoStart });
      await plugin.messaging.broadcast({
        type: 'settings_saved',
        mode,
        autoStart,
        at: Date.now(),
      });
      await plugin.widget.closePopup();
    } catch (error) {
      const normalized = normalizeError({
        code: 'E_SETTINGS_SAVE',
        error,
      });
      setSaveError(normalized);
      await notifyError(plugin, normalized, { scope: 'settings' });
    } finally {
      setIsSaving(false);
    }
  };

  const onCancel = async () => {
    await plugin.widget.closePopup();
  };

  if (loadError) {
    return (
      <div className="pagesync-popup-root">
        <div className="pagesync-popup-panel">
          <h2>PageSync Settings</h2>
          <div className="pagesync-error-inline" role="alert">
            {loadError.message} ({loadError.code})
          </div>
          <div className="pagesync-popup-actions">
            <button onClick={() => void onCancel()}>Close</button>
            <button onClick={() => void loadSettings()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (!config) {
    return <div className="pagesync-popup-root">Loading settings...</div>;
  }

  return (
    <div className="pagesync-popup-root">
      <div className="pagesync-popup-panel">
        <h2>PageSync Settings</h2>

        <label className="pagesync-field">
          <span>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as DeviceMode)}>
            <option value="host">Host</option>
            <option value="client">Client</option>
          </select>
        </label>

        <label className="pagesync-checkbox-row">
          <span>Auto Start</span>
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => setAutoStart(e.target.checked)}
          />
        </label>

        <div className="pagesync-help">
          <p>
            <strong>Host:</strong> use on the device you control. Its page navigation is sent to the
            server.
          </p>
          <p>
            <strong>Client:</strong> use on devices that should follow the host page automatically.
          </p>
        </div>

        {saveError ? (
          <div className="pagesync-error-inline" role="alert">
            {saveError.message} ({saveError.code})
          </div>
        ) : null}

        <div className="pagesync-popup-actions">
          <button onClick={() => void onCancel()}>Cancel</button>
          <button disabled={isSaving} onClick={() => void onSave()}>
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

renderWidget(SettingsPopupWidget);
