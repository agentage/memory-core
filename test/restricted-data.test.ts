import { describe, expect, it } from 'vitest';
import {
  assertNoRestricted,
  findRestricted,
  frontmatterText,
  RestrictedContentError,
  restrictedMessage,
} from '../src/contract/restricted-data.js';

// Each high-confidence secret class is refused; ordinary notes that merely mention
// credential words pass. The refusal message is stable and never echoes the value.
describe('restricted-data screen', () => {
  const secrets: Array<[string, string, string]> = [
    ['OpenAI key', 'key is sk-abcdefghijklmnopqrstuvwxyz012345', 'an API key or access token'],
    [
      'GitHub token',
      'token ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      'an API key or access token',
    ],
    ['GitHub OAuth', 'gho_0123456789abcdefghijklmnopqrstuvwxyz', 'an API key or access token'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE here', 'an API key or access token'],
    ['Slack token', 'xoxb-0123456789-abcdefghijkl', 'an API key or access token'],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'a JSON Web Token',
    ],
    [
      'PEM private key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END-----',
      'a private key',
    ],
    ['password assignment', 'password: hunter2secret', 'a password or secret value'],
    ['passwd assignment', 'passwd=SuperSecret99', 'a password or secret value'],
    ['api_key assignment', 'api_key = 9f8e7d6c5b4a3210', 'a password or secret value'],
    ['OTP code', 'your verification code is 483920', 'a one-time or MFA code'],
    ['SSN', 'ssn 123-45-6789 on file', 'a government identifier'],
    ['payment card', 'card 4111 1111 1111 1111 expires soon', 'a payment card number'],
  ];

  for (const [name, text, kind] of secrets) {
    it(`refuses ${name}`, () => {
      expect(findRestricted(text)).toBe(kind);
      expect(() => assertNoRestricted(text)).toThrow(RestrictedContentError);
    });
  }

  const clean: Array<[string, string]> = [
    ['prose about auth', 'Notes on the login flow and how our auth service issues sessions.'],
    ['password placeholder', 'password: required'],
    ['masked password', 'password: ****'],
    ['hyphenated words', 'The task-force-management-system rollout is on track.'],
    ['a long id number', 'Order 1234567890123 shipped on 2026-01-01.'],
    ['plain sentence', 'Remember to rotate keys quarterly and keep secrets out of notes.'],
  ];

  for (const [name, text] of clean) {
    it(`passes ${name}`, () => {
      expect(findRestricted(text)).toBeNull();
      expect(() => assertNoRestricted(text)).not.toThrow();
    });
  }

  it('exposes the exact canonical message and kind', () => {
    expect(restrictedMessage('a private key')).toBe(
      'Refused: this appears to contain a private key. Memory stores durable notes and knowledge, not secrets, credentials, one-time codes, or payment/government identifiers - remove it and try again.'
    );
    const err = new RestrictedContentError('an API key or access token');
    expect(err.kind).toBe('an API key or access token');
    expect(err.message).toBe(restrictedMessage('an API key or access token'));
  });

  it('never echoes the matched value in the message', () => {
    const err = new RestrictedContentError(findRestricted('sk-abcdefghijklmnopqrstuvwxyz012345')!);
    expect(err.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('screens secrets hidden in frontmatter via frontmatterText', () => {
    const text = frontmatterText({
      title: 'notes',
      api_key: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    });
    expect(findRestricted(text)).toBe('an API key or access token');
    expect(findRestricted(frontmatterText({ title: 'clean', status: 'active' }))).toBeNull();
  });
});
