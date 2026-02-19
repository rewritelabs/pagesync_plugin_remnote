import { AppEvents, renderWidget, useAPIEventListener, usePlugin } from '@remnote/plugin-sdk';
import { useEffect, useRef, useState } from 'react';
import {
  PAGESYNC_MESSAGE_TYPES,
  type PageSyncRuntimeCommandAction,
  type PageSyncRuntimeStatusMessage,
} from '../constants';
import '../style.css';
import '../App.css';

type BroadcastEnvelope = {
  message?: unknown;
};

function unwrapBroadcastPayload(args: unknown): unknown {
  if (args && typeof args === 'object' && 'message' in (args as BroadcastEnvelope)) {
    return (args as BroadcastEnvelope).message;
  }
  return args;
}

function isRuntimeStatusMessage(value: unknown): value is PageSyncRuntimeStatusMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === PAGESYNC_MESSAGE_TYPES.runtimeStatus &&
    (candidate.runtimeState === 'off' || candidate.runtimeState === 'sync' || candidate.runtimeState === 'idle')
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="pagesync-icon-button" onClick={onClick} title={title} aria-label={title}>
      {children}
    </button>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pagesync-icon">
      <path d="M19.14 12.94a7.53 7.53 0 0 0 .05-.94 7.53 7.53 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.53 7.53 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pagesync-icon">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pagesync-icon">
      <path d="M12 5a7 7 0 0 1 6.36 4H16v2h5V6h-2v1.56A9 9 0 0 0 3 12h2a7 7 0 0 1 7-7Zm7 7a7 7 0 0 1-7 7 7 7 0 0 1-6.36-4H8v-2H3v5h2v-1.56A9 9 0 0 0 21 12h-2Z" />
    </svg>
  );
}

export const PageSyncControlsWidget = () => {
  const plugin = usePlugin();
  const [status, setStatus] = useState<PageSyncRuntimeStatusMessage | null>(null);
  const [showSyncTextInActiveMode, setShowSyncTextInActiveMode] = useState(false);
  const syncActionRef = useRef<HTMLButtonElement | null>(null);

  const sendCommand = async (action: PageSyncRuntimeCommandAction) => {
    await plugin.messaging.broadcast({
      type: PAGESYNC_MESSAGE_TYPES.runtimeCommand,
      action,
      at: Date.now(),
    });
  };

  const requestStatus = async () => {
    await plugin.messaging.broadcast({
      type: PAGESYNC_MESSAGE_TYPES.runtimeStatusRequest,
      requestId: `controls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    });
  };

  useEffect(() => {
    void requestStatus();
  }, []);

  useAPIEventListener(AppEvents.MessageBroadcast, undefined, (args) => {
    const payload = unwrapBroadcastPayload(args);
    if (!isRuntimeStatusMessage(payload)) {
      return;
    }
    setStatus(payload);
  });

  useEffect(() => {
    if (!status?.isActive) {
      setShowSyncTextInActiveMode(false);
      return;
    }

    const el = syncActionRef.current;
    if (!el) {
      return;
    }

    const update = () => {
      // Show text once the actual sync button has enough space.
      setShowSyncTextInActiveMode(el.clientWidth >= 90);
    };

    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();

    return () => observer.disconnect();
  }, [status?.isActive]);

  if (!status || !status.mode) {
    return <div className="pagesync-card">Loading PageSync...</div>;
  }

  return (
    <div className="pagesync-card">
      <div className="pagesync-controls full-width">
        <div className="pagesync-left-group">
          <IconButton title="Settings" onClick={() => void sendCommand('open_settings')}>
            <SettingsIcon />
          </IconButton>
        </div>

        <div className="pagesync-right-group">
          {!status.isActive ? (
            <button
              className="pagesync-sync-text-button pagesync-sync-fill"
              onClick={() => void sendCommand('sync_toggle_or_start')}
            >
              Sync
            </button>
          ) : (
            <>
              <IconButton title="Stop" onClick={() => void sendCommand('stop')}>
                <StopIcon />
              </IconButton>
              <button
                ref={syncActionRef}
                className={`pagesync-icon-button pagesync-sync-action-button ${
                  showSyncTextInActiveMode ? 'pagesync-show-text' : 'pagesync-show-icon'
                }`}
                title="Sync Now"
                aria-label="Sync Now"
                onClick={() => void sendCommand('sync_now')}
              >
                <span className="pagesync-sync-label">Sync</span>
                <span className="pagesync-sync-icon-wrap">
                  <SyncIcon />
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

renderWidget(PageSyncControlsWidget);
