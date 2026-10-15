import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, t, normalizeLang, localeFor } from '../src/i18n.mjs';
import { CONDITIONS, ORDER_STATUSES } from '../src/db.mjs';
import { formatMoney } from '../src/cart.mjs';

test('every English key has a Korean translation and vice versa', () => {
  const en = Object.keys(DICTS.en), ko = Object.keys(DICTS.ko);
  const missingKo = en.filter((k) => !(k in DICTS.ko));
  const extraKo = ko.filter((k) => !(k in DICTS.en));
  assert.deepEqual(missingKo, [], 'keys missing in ko');
  assert.deepEqual(extraKo, [], 'keys only in ko');
  for (const k of en) { assert.ok(DICTS.en[k].trim(), `empty en: ${k}`); assert.ok(DICTS.ko[k].trim(), `empty ko: ${k}`); }
});

test('placeholders match between languages', () => {
  for (const k of Object.keys(DICTS.en)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(ph(DICTS.ko[k]), ph(DICTS.en[k]), `placeholder mismatch in ${k}`);
  }
});

test('conditions and order statuses are translated', () => {
  for (const c of Object.keys(CONDITIONS)) { assert.notEqual(t('ko', `cond.${c}`), `cond.${c}`); assert.notEqual(t('en', `cond.${c}`), `cond.${c}`); }
  for (const s of ORDER_STATUSES) assert.notEqual(t('ko', `status.${s}`), `status.${s}`);
});

test('t substitutes variables and falls back', () => {
  assert.equal(t('en', 'cart.only_left', { n: 2, name: 'GPU' }), 'Only 2 of "GPU" left in stock.');
  assert.equal(t('ko', 'cart.only_left', { n: 2, name: 'GPU' }), '"GPU"의 재고가 2개 남았습니다.');
  assert.equal(t('xx', 'cart.free'), 'Free', 'unknown language falls back to English');
  assert.equal(t('ko', 'no.such.key'), 'no.such.key');
  assert.equal(normalizeLang('ko'), 'ko'); assert.equal(normalizeLang('fr'), 'en'); assert.equal(normalizeLang(undefined), 'en');
});

test('Korean locale formats money and currency', () => {
  assert.equal(formatMoney(123456, 'usd', localeFor('ko')), 'US$1,234.56');
  assert.equal(formatMoney(15000, 'krw', localeFor('ko')), '₩15,000');
  assert.equal(formatMoney(15000, 'krw', localeFor('en')), '₩15,000');
});
