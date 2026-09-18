import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type BrowserNavigationDenialReason =
  | 'INVALID_URL'
  | 'HTTPS_REQUIRED'
  | 'HTTPS_PORT_NOT_ALLOWED'
  | 'CREDENTIALS_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWLISTED'
  | 'BLOCKED_IP_LITERAL'
  | 'DNS_RESOLUTION_FAILED'
  | 'BLOCKED_RESOLVED_IP';

export type BlockedIpCategory =
  | 'UNSPECIFIED'
  | 'PRIVATE'
  | 'LOOPBACK'
  | 'LINK_LOCAL'
  | 'RESERVED'
  | 'MULTICAST';

export interface BrowserNavigationDecision {
  readonly allowed: boolean;
  readonly normalizedUrl?: string;
  readonly hostname?: string;
  readonly reason?: BrowserNavigationDenialReason;
  readonly blockedIpCategory?: BlockedIpCategory;
}

export interface BrowserNavigationPolicyOptions {
  readonly allowedHosts: readonly string[];
  /** Exact matching remains the default. Prefer explicit `*.example.invalid` entries. */
  readonly allowSubdomains?: boolean;
  /** Override DNS resolution in tests or with a resolver that enforces platform DNS policy. */
  readonly resolveHostname?: (hostname: string) => Promise<readonly string[]>;
}

type AllowedHost = { hostname: string; wildcard: boolean };

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function normalizeBrowserHostname(hostname: string): string {
  const candidate = hostname.trim();
  if (!candidate) throw new TypeError('Browser hostname must not be empty');

  const authority = candidate.includes(':') && !candidate.startsWith('[')
    ? `[${candidate}]`
    : candidate;
  let parsed: URL;
  try {
    parsed = new URL(`https://${authority}`);
  } catch {
    throw new TypeError(`Invalid browser hostname: ${hostname}`);
  }

  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError(`Invalid browser hostname: ${hostname}`);
  }

  const normalized = stripIpv6Brackets(parsed.hostname).toLowerCase().replace(/\.$/, '');
  if (!normalized) throw new TypeError(`Invalid browser hostname: ${hostname}`);
  return normalized;
}

function parseAllowedHost(value: string, allowSubdomains: boolean): AllowedHost {
  const trimmed = value.trim();
  const wildcard = trimmed.startsWith('*.');
  const hostname = normalizeBrowserHostname(wildcard ? trimmed.slice(2) : trimmed);
  return { hostname, wildcard: wildcard || allowSubdomains };
}

function matchesAllowedHost(hostname: string, allowedHost: AllowedHost): boolean {
  if (hostname === allowedHost.hostname) return true;
  return allowedHost.wildcard && hostname.endsWith(`.${allowedHost.hostname}`);
}

function parseIpv4(ip: string): number[] {
  return ip.split('.').map(part => Number(part));
}

function classifyIpv4(ip: string): BlockedIpCategory | undefined {
  const [a, b, c] = parseIpv4(ip);
  if (a === 0) return 'UNSPECIFIED';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'PRIVATE';
  if (a === 127) return 'LOOPBACK';
  if (a === 169 && b === 254) return 'LINK_LOCAL';
  if (a >= 224 && a <= 239) return 'MULTICAST';
  if (
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 240
  ) return 'RESERVED';
  return undefined;
}

function parseIpv6Words(ip: string): number[] | undefined {
  let candidate = ip.toLowerCase().split('%', 1)[0];
  const ipv4Match = candidate.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  let ipv4Words: number[] = [];
  if (ipv4Match) {
    const octets = parseIpv4(ipv4Match[1]);
    if (octets.length !== 4 || octets.some(value => value < 0 || value > 255)) return undefined;
    ipv4Words = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    candidate = candidate.slice(0, candidate.length - ipv4Match[1].length) + ipv4Words.map(value => value.toString(16)).join(':');
  }
  const halves = candidate.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(word => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function classifyIpv6(ip: string): BlockedIpCategory | undefined {
  const words = parseIpv6Words(ip);
  if (!words) return 'RESERVED';
  if (words.every(word => word === 0)) return 'UNSPECIFIED';
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return 'LOOPBACK';

  const mappedIpv4 = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  if (mappedIpv4) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return classifyIpv4(ipv4);
  }

  const first = words[0];
  if ((first & 0xfe00) === 0xfc00) return 'PRIVATE';
  if ((first & 0xffc0) === 0xfe80) return 'LINK_LOCAL';
  if ((first & 0xff00) === 0xff00) return 'MULTICAST';
  if ((first & 0xffc0) === 0xfec0 || first === 0x2001 && words[1] === 0x0db8) return 'RESERVED';
  return undefined;
}

export function classifyBlockedIpLiteral(hostname: string): BlockedIpCategory | undefined {
  const candidate = stripIpv6Brackets(hostname).toLowerCase();
  const family = isIP(candidate);
  if (family === 4) return classifyIpv4(candidate);
  if (family === 6) return classifyIpv6(candidate);
  return undefined;
}

export class BrowserNavigationPolicy {
  private readonly allowedHosts: readonly AllowedHost[];
  private readonly resolveHostname: (hostname: string) => Promise<readonly string[]>;

  constructor(options: BrowserNavigationPolicyOptions) {
    if (!options.allowedHosts.length) throw new TypeError('At least one allowed browser host is required');
    this.allowedHosts = options.allowedHosts.map(host => parseAllowedHost(host, options.allowSubdomains ?? false));
    this.resolveHostname = options.resolveHostname ?? (async hostname =>
      (await lookup(hostname, { all: true, verbatim: true })).map(address => address.address));
  }

  evaluate(target: string | URL): BrowserNavigationDecision {
    let url: URL;
    try {
      url = target instanceof URL ? new URL(target.href) : new URL(target);
    } catch {
      return { allowed: false, reason: 'INVALID_URL' };
    }

    if (url.protocol !== 'https:') return { allowed: false, reason: 'HTTPS_REQUIRED' };
    if (url.port && url.port !== '443') return { allowed: false, reason: 'HTTPS_PORT_NOT_ALLOWED' };
    if (url.username || url.password) return { allowed: false, reason: 'CREDENTIALS_NOT_ALLOWED' };

    const hostname = normalizeBrowserHostname(url.hostname);
    // URL.hostname may preserve a trailing root-label dot when reassigned. Rebuild
    // the host explicitly so the normalized URL matches the host we authorized.
    url.host = url.port ? `${hostname}:${url.port}` : hostname;
    const blockedIpCategory = classifyBlockedIpLiteral(hostname);
    if (blockedIpCategory) {
      return { allowed: false, hostname, reason: 'BLOCKED_IP_LITERAL', blockedIpCategory };
    }
    if (!this.allowedHosts.some(allowed => matchesAllowedHost(hostname, allowed))) {
      return { allowed: false, hostname, reason: 'HOST_NOT_ALLOWLISTED' };
    }
    return { allowed: true, hostname, normalizedUrl: url.href };
  }

  assertAllowed(target: string | URL): URL {
    const decision = this.evaluate(target);
    if (!decision.allowed) throw new BrowserNavigationPolicyError(decision);
    return new URL(decision.normalizedUrl!);
  }

  /** Every redirect is checked as a fresh untrusted navigation target. */
  evaluateRedirect(_previousUrl: string | URL, redirectTarget: string | URL): BrowserNavigationDecision {
    return this.evaluate(redirectTarget);
  }

  assertRedirectAllowed(previousUrl: string | URL, redirectTarget: string | URL): URL {
    const decision = this.evaluateRedirect(previousUrl, redirectTarget);
    if (!decision.allowed) throw new BrowserNavigationPolicyError(decision);
    return new URL(decision.normalizedUrl!);
  }

  /**
   * Resolve and validate a target before navigation. A hostname may be allowlisted
   * while resolving to an internal address, so every returned address is checked and
   * resolution failures are denied rather than treated as safe.
   */
  async evaluateResolved(target: string | URL): Promise<BrowserNavigationDecision> {
    const decision = this.evaluate(target);
    if (!decision.allowed || !decision.hostname) return decision;

    let addresses: readonly string[];
    try {
      addresses = await this.resolveHostname(decision.hostname);
    } catch {
      return { allowed: false, hostname: decision.hostname, reason: 'DNS_RESOLUTION_FAILED' };
    }
    if (!addresses.length) {
      return { allowed: false, hostname: decision.hostname, reason: 'DNS_RESOLUTION_FAILED' };
    }
    for (const address of addresses) {
      const blockedIpCategory = classifyBlockedIpLiteral(address);
      if (blockedIpCategory) {
        return {
          allowed: false,
          hostname: decision.hostname,
          reason: 'BLOCKED_RESOLVED_IP',
          blockedIpCategory,
        };
      }
    }
    return decision;
  }

  async assertResolvedAllowed(target: string | URL): Promise<URL> {
    const decision = await this.evaluateResolved(target);
    if (!decision.allowed) throw new BrowserNavigationPolicyError(decision);
    return new URL(decision.normalizedUrl!);
  }
}

export class BrowserNavigationPolicyError extends Error {
  readonly decision: BrowserNavigationDecision;

  constructor(decision: BrowserNavigationDecision) {
    super(`Browser navigation denied: ${decision.reason ?? 'UNKNOWN'}`);
    this.name = 'BrowserNavigationPolicyError';
    this.decision = decision;
  }
}

export type HumanVerificationKind = 'CAPTCHA' | 'MFA' | 'ANTI_BOT' | 'AUTH';

export const HUMAN_VERIFICATION_KINDS: readonly HumanVerificationKind[] = ['CAPTCHA', 'MFA', 'ANTI_BOT', 'AUTH'];

/**
 * Runtime guard for the verification kind contract.
 *
 * Provider snapshots are untrusted input: a hostile page can put any value on an
 * annotated verification control, and a TypeScript annotation does not survive the
 * boundary. Every value that becomes a typed `HumanVerificationKind` must pass this
 * check first, so an unrecognized string can never reach a typed field or a
 * persisted record.
 */
export function isHumanVerificationKind(value: unknown): value is HumanVerificationKind {
  return typeof value === 'string' && (HUMAN_VERIFICATION_KINDS as readonly string[]).includes(value);
}

export interface HumanVerificationClassification {
  readonly requiresHuman: true;
  readonly kind: HumanVerificationKind;
  readonly resumable: true;
  readonly bypassAllowed: false;
}

export interface HumanVerificationSignals {
  readonly captcha?: boolean;
  readonly mfa?: boolean;
  readonly antiBot?: boolean;
  readonly authentication?: boolean;
}

export function classifyHumanVerification(
  signals: HumanVerificationSignals,
): HumanVerificationClassification | undefined {
  let kind: HumanVerificationKind | undefined;
  if (signals.captcha) kind = 'CAPTCHA';
  else if (signals.mfa) kind = 'MFA';
  else if (signals.antiBot) kind = 'ANTI_BOT';
  else if (signals.authentication) kind = 'AUTH';
  return kind
    ? { requiresHuman: true, kind, resumable: true, bypassAllowed: false }
    : undefined;
}
