/**
 * Shared error type. Lives in its own module so the mock transport can throw the
 * same class the HTTP transport throws without importing `client.ts` (which
 * imports the mock, and would create a cycle).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isValidation(): boolean {
    return this.status === 422;
  }
}
