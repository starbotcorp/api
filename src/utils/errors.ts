// Standardized error handling utilities
// Fix #14: Inconsistent Error Responses

export enum ErrorCode {
  NOT_FOUND = 'not_found',
  UNAUTHORIZED = 'unauthorized',
  FORBIDDEN = 'forbidden',
  BAD_REQUEST = 'bad_request',
  INTERNAL_ERROR = 'internal_error',
  RATE_LIMITED = 'rate_limited',
  INVALID_TOKEN = 'invalid_token',
  TOKEN_EXPIRED = 'token_expired',
  VALIDATION_ERROR = 'validation_error',
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(message: string = 'Resource not found', details?: unknown): AppError {
    return new AppError(ErrorCode.NOT_FOUND, message, 404, details);
  }

  static unauthorized(message: string = 'Unauthorized', details?: unknown): AppError {
    return new AppError(ErrorCode.UNAUTHORIZED, message, 401, details);
  }

  static forbidden(message: string = 'Access denied', details?: unknown): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message, 403, details);
  }

  static badRequest(message: string = 'Bad request', details?: unknown): AppError {
    return new AppError(ErrorCode.BAD_REQUEST, message, 400, details);
  }

  static rateLimited(retryAfter: number, message: string = 'Too many requests'): AppError {
    return new AppError(ErrorCode.RATE_LIMITED, message, 429, { retryAfter });
  }

  static invalidToken(message: string = 'Invalid token'): AppError {
    return new AppError(ErrorCode.INVALID_TOKEN, message, 401);
  }

  static tokenExpired(message: string = 'Token expired'): AppError {
    return new AppError(ErrorCode.TOKEN_EXPIRED, message, 401);
  }

  static validationError(message: string, details?: unknown): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, 400, details);
  }

  static internal(message: string = 'Internal server error', details?: unknown): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, message, 500, details);
  }
}

export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  statusCode: number;
  details?: unknown;
  retry_after_seconds?: number;
}

export function formatErrorResponse(error: AppError, includeDetails: boolean = false): ErrorResponse {
  const response: ErrorResponse = {
    error: error.code,
    message: error.message,
    statusCode: error.statusCode,
  };

  if (includeDetails && error.details) {
    response.details = error.details;
  }

  if (error.code === ErrorCode.RATE_LIMITED && error.details) {
    const details = error.details as { retryAfter?: number };
    if (details.retryAfter) {
      response.retry_after_seconds = details.retryAfter;
    }
  }

  return response;
}
