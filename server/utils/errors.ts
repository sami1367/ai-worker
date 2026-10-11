export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'app_error',
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function createErrorResponse(err: unknown, correlationId: string) {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.message,
          correlationId,
          details: err.details,
        },
      },
    }
  }

  const isProd = process.env.NODE_ENV === 'production'
  return {
    statusCode: 500,
    body: {
      error: {
        code: 'internal_error',
        message: isProd ? 'An unexpected error occurred' : (err instanceof Error ? err.message : 'Unknown error'),
        correlationId,
      },
    },
  }
}
