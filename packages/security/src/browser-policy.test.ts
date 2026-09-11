import { describe, expect, it } from 'vitest';
import {
  BrowserNavigationPolicy,
  BrowserNavigationPolicyError,
  classifyBlockedIpLiteral,
  classifyHumanVerification,
  normalizeBrowserHostname,
} from './browser-policy';

describe('BrowserNavigationPolicy', () => {
  const policy = new BrowserNavigationPolicy({
    allowedHosts: ['jobs.example.invalid', '*.ats.example.invalid'],
  });

  it('allows HTTPS navigation only to normalized allowlisted hosts', () => {
    expect(policy.evaluate('https://JOBS.EXAMPLE.INVALID./apply?id=1')).toMatchObject({
      allowed: true,
      hostname: 'jobs.example.invalid',
      normalizedUrl: 'https://jobs.example.invalid/apply?id=1',
    });
    expect(normalizeBrowserHostname('JOBS.EXAMPLE.INVALID.')).toBe('jobs.example.invalid');
    expect(policy.evaluate('http://jobs.example.invalid/apply')).toMatchObject({
      allowed: false,
      reason: 'HTTPS_REQUIRED',
    });
  });

  it('matches host labels rather than confusing malicious suffixes', () => {
    expect(policy.evaluate('https://apply.ats.example.invalid/')).toMatchObject({ allowed: true });
    expect(policy.evaluate('https://ats.example.invalid.evil.invalid/')).toMatchObject({
      allowed: false,
      reason: 'HOST_NOT_ALLOWLISTED',
    });
    expect(policy.evaluate('https://notexample.invalid/')).toMatchObject({
      allowed: false,
      reason: 'HOST_NOT_ALLOWLISTED',
    });
    expect(policy.evaluate('https://jobs.example.invalid.evil.invalid/')).toMatchObject({
      allowed: false,
      reason: 'HOST_NOT_ALLOWLISTED',
    });
  });

  it('denies credential-bearing and malformed URLs', () => {
    expect(policy.evaluate('https://user:secret@jobs.example.invalid/')).toMatchObject({
      allowed: false,
      reason: 'CREDENTIALS_NOT_ALLOWED',
    });
    expect(policy.evaluate('not-a-url')).toEqual({ allowed: false, reason: 'INVALID_URL' });
  });

  it('denies private, loopback, link-local, reserved, and mapped IP literals', () => {
    const categories = [
      ['https://10.1.2.3/', 'PRIVATE'],
      ['https://127.0.0.1/', 'LOOPBACK'],
      ['https://169.254.169.254/', 'LINK_LOCAL'],
      ['https://192.0.2.1/', 'RESERVED'],
      ['https://[fc00::1]/', 'PRIVATE'],
      ['https://[::1]/', 'LOOPBACK'],
      ['https://[fe80::1]/', 'LINK_LOCAL'],
      ['https://[2001:db8::1]/', 'RESERVED'],
      ['https://[::ffff:7f00:1]/', 'LOOPBACK'],
    ] as const;

    for (const [url, category] of categories) {
      expect(new BrowserNavigationPolicy({ allowedHosts: [new URL(url).hostname] }).evaluate(url)).toMatchObject({
        allowed: false,
        reason: 'BLOCKED_IP_LITERAL',
        blockedIpCategory: category,
      });
    }
    expect(classifyBlockedIpLiteral('8.8.8.8')).toBeUndefined();
  });

  it('revalidates each redirect target and offers an asserting API', () => {
    expect(policy.evaluateRedirect(
      'https://jobs.example.invalid/start',
      'https://apply.ats.example.invalid/next',
    )).toMatchObject({ allowed: true });
    expect(policy.evaluateRedirect(
      'https://jobs.example.invalid/start',
      'https://127.0.0.1/internal',
    )).toMatchObject({ allowed: false, reason: 'BLOCKED_IP_LITERAL' });
    expect(() => policy.assertRedirectAllowed(
      'https://jobs.example.invalid/start',
      'https://evil.invalid/',
    )).toThrow(BrowserNavigationPolicyError);
  });
});

describe('human verification classification', () => {
  it.each([
    [{ captcha: true }, 'CAPTCHA'],
    [{ mfa: true }, 'MFA'],
    [{ antiBot: true }, 'ANTI_BOT'],
    [{ authentication: true }, 'AUTH'],
  ] as const)('classifies %j as an explicit human-only barrier', (signals, kind) => {
    expect(classifyHumanVerification(signals)).toEqual({
      requiresHuman: true,
      kind,
      resumable: true,
      bypassAllowed: false,
    });
  });

  it('does not create a handoff without an explicit barrier signal', () => {
    expect(classifyHumanVerification({})).toBeUndefined();
  });

  it('prioritizes CAPTCHA and MFA when several conservative signals occur', () => {
    expect(classifyHumanVerification({ captcha: true, authentication: true })?.kind).toBe('CAPTCHA');
    expect(classifyHumanVerification({ mfa: true, antiBot: true })?.kind).toBe('MFA');
  });
});
