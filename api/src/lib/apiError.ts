export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    // Optional structured payload merged into the response `error` object
    // (e.g. { conflicts: [...] } for a 409 SCHEDULING_CONFLICT).
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}
