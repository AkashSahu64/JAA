/**
 * Email providers and persistence layers are untrusted failure sources.
 * Never reflect their exception text to an API client.
 */
export function safeEmailErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}
