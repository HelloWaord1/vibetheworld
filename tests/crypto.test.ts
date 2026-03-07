import { describe, it, expect } from 'vitest';
import { generateToken, hashPassword, verifyPassword } from '../src/utils/crypto.js';

describe('crypto', () => {
  it('generateToken returns a UUID', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('generates unique tokens', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });

  it('hashPassword and verifyPassword work together', () => {
    const hash = hashPassword('mypassword');
    expect(verifyPassword('mypassword', hash)).toBe(true);
    expect(verifyPassword('wrongpassword', hash)).toBe(false);
  });
});
