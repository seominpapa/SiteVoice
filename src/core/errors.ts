export class ServiceError extends Error {
  override name = 'ServiceError'
}

export function userMessage(error: unknown, fallback: string) {
  return error instanceof ServiceError ? error.message : fallback
}
