import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const format = /^scrypt\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

export function isPasswordHash(value) {
  return typeof value === 'string' && format.test(value);
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Password must contain 12 to 1024 characters');
  }
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, options);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  if (!isPasswordHash(encoded) || typeof password !== 'string' || password.length > 1024) return false;
  const [, salt, expected] = encoded.split('$');
  const actual = await deriveKey(password, Buffer.from(salt, 'base64url'), 64, options);
  return timingSafeEqual(actual, Buffer.from(expected, 'base64url'));
}
