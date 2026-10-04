// 错误码与统一错误类型

export const ErrorCodes = {
  VALIDATION: 'E_VALIDATION',
  NOT_FOUND: 'E_NOT_FOUND',
  DUPLICATE_ID: 'E_DUPLICATE_ID',
  UNKNOWN_PARTICIPANT: 'E_UNKNOWN_PARTICIPANT',
  SEQ_GAP: 'E_SEQ_GAP',
  RECV_MISMATCH: 'E_RECV_MISMATCH',
  DUPLICATE_RECV: 'E_DUPLICATE_RECV',
  MISSING_SEND: 'E_MISSING_SEND',
  CYCLE: 'E_CYCLE',
  LIMIT_EXCEEDED: 'E_LIMIT_EXCEEDED',
  BAD_REQUEST: 'E_BAD_REQUEST',
  INTERNAL: 'E_INTERNAL'
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export const LIMITS = {
  MAX_PARTICIPANTS: 64,
  MAX_EVENTS: 10000,
  MAX_RETURN_ROWS: 1000,
  MAX_ID_LENGTH: 128,
  MAX_MESSAGE_LENGTH: 128
} as const;

export const ALGORITHM_VERSION = 'vc-vector-clock-1.0.0';
