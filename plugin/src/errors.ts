export type ErrorCode =
  | 'E_WS_OPEN'
  | 'E_WS_RUNTIME'
  | 'E_STATE_FETCH'
  | 'E_UPDATE_POST'
  | 'E_NAV_REMOTE_OPEN'
  | 'E_SETTINGS_LOAD'
  | 'E_SETTINGS_SAVE'
  | 'E_INVALID_WS_PAYLOAD';

export type ErrorSeverity = 'info' | 'warn' | 'error';

export type UserFacingError = {
  code: ErrorCode;
  message: string;
  severity: ErrorSeverity;
  details?: string;
};

const MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  E_WS_OPEN: 'Unable to connect. Retrying.',
  E_WS_RUNTIME: 'Connection unstable. Retrying.',
  E_STATE_FETCH: 'Unable to read sync state from server.',
  E_UPDATE_POST: "Could not send update. Will retry on next change.",
  E_NAV_REMOTE_OPEN: 'Synced page is not available on this device.',
  E_SETTINGS_LOAD: 'Unable to load settings.',
  E_SETTINGS_SAVE: 'Unable to save settings.',
  E_INVALID_WS_PAYLOAD: 'Received invalid sync payload.',
};

const SEVERITY_BY_CODE: Record<ErrorCode, ErrorSeverity> = {
  E_WS_OPEN: 'warn',
  E_WS_RUNTIME: 'warn',
  E_STATE_FETCH: 'error',
  E_UPDATE_POST: 'warn',
  E_NAV_REMOTE_OPEN: 'warn',
  E_SETTINGS_LOAD: 'error',
  E_SETTINGS_SAVE: 'error',
  E_INVALID_WS_PAYLOAD: 'warn',
};

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function normalizeError(input: {
  code: ErrorCode;
  severity?: ErrorSeverity;
  message?: string;
  error?: unknown;
  details?: string;
}): UserFacingError {
  return {
    code: input.code,
    message: input.message ?? MESSAGE_BY_CODE[input.code],
    severity: input.severity ?? SEVERITY_BY_CODE[input.code],
    details: input.details ?? (input.error !== undefined ? errorDetails(input.error) : undefined),
  };
}
