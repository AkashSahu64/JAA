// HTML entity encoding for XSS prevention
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Remove potential injection patterns
export function sanitizeInput(input: string): string {
  // Remove null bytes
  let sanitized = input.replace(/\0/g, '');
  // Limit length
  sanitized = sanitized.slice(0, 10000);
  return sanitized.trim();
}

// Validate email format
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Sanitize file name
export function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\./g, '_')
    .slice(0, 255);
}

// Validate URL
export function isValidUrl(url: string, allowedProtocols: readonly string[] = ['https:']): boolean {
  try {
    const parsed = new URL(url);
    return allowedProtocols.includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

// Mask sensitive data for logs
export function maskSensitive(value: string, visibleChars: number = 4): string {
  if (!Number.isFinite(visibleChars)) return '****';
  const visible = Math.max(0, Math.floor(visibleChars));
  if (value.length <= visible) return '****';
  return value.slice(0, visible) + '*'.repeat(Math.min(value.length - visible, 20));
}
