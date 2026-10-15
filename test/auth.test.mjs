import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sign, unsign, RateLimiter, validEmail } from '../src/auth.mjs';

test('password hashing verifies and rejects', () => {
  const h = hashPassword('correct horse');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.ok(!verifyPassword('x', null));
  assert.notEqual(hashPassword('a'), hashPassword('a'), 'salted');
});

test('sign/unsign detects tampering', () => {
  const s = sign('session123', 'secret');
  assert.equal(unsign(s, 'secret'), 'session123');
  assert.equal(unsign(s, 'other'), null);
  assert.equal(unsign(s.replace('session123', 'session124'), 'secret'), null);
  assert.equal(unsign('nodot', 'secret'), null);
  assert.equal(unsign(undefined, 'secret'), null);
});

test('rate limiter', () => {
  const rl = new RateLimiter(3, 1000);
  assert.ok(rl.hit('k')); assert.ok(rl.hit('k')); assert.ok(rl.hit('k'));
  assert.ok(!rl.hit('k'));
  assert.ok(rl.hit('other'));
  rl.reset('k');
  assert.ok(rl.hit('k'));
});

test('validEmail', () => {
  assert.ok(validEmail('a@b.co'));
  assert.ok(!validEmail('a@b'));
  assert.ok(!validEmail('not an email'));
  assert.ok(!validEmail(''));
});
