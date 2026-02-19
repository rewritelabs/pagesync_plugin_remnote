import { renderWidget } from '@remnote/plugin-sdk';
import { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../index.css';
import { usePageSyncEngine } from './use_pagesync_sync_engine';

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
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
  const { config, isActive, onPressSync, onPressResync, onStop, onOpenSettings } =
    usePageSyncEngine();
  const [showSyncTextInActiveMode, setShowSyncTextInActiveMode] = useState(false);
  const syncActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isActive) {
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
  }, [isActive]);

  if (!config) {
    return <div className="pagesync-card">Loading PageSync...</div>;
  }

  return (
    <div className="pagesync-card">
      <div className="pagesync-controls full-width">
        <div className="pagesync-left-group">
          <IconButton title="Settings" onClick={() => void onOpenSettings()}>
            <SettingsIcon />
          </IconButton>
        </div>

        <div className="pagesync-right-group">
          {!isActive ? (
            <button
              className="pagesync-sync-text-button pagesync-sync-fill"
              onClick={() => void onPressSync()}
            >
              Sync
            </button>
          ) : (
            <>
              <IconButton title="Stop" onClick={() => void onStop()}>
                <StopIcon />
              </IconButton>
              <button
                ref={syncActionRef}
                className={`pagesync-icon-button pagesync-sync-action-button ${
                  showSyncTextInActiveMode ? 'pagesync-show-text' : 'pagesync-show-icon'
                }`}
                title="Sync Now"
                aria-label="Sync Now"
                onClick={() => void onPressResync()}
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
