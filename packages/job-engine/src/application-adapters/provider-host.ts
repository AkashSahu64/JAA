export function safeProviderApplicationHost(url: string, allowedHosts: readonly string[]): string | null {
  try {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    return target.protocol === 'https:' && !target.username && !target.password
      && !target.port && allowedHosts.includes(host) ? host : null;
  } catch {
    return null;
  }
}
