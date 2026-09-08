import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDevice } from '../src/public/device.js';

test('classifyDevice buckets real UA strings by type and browser', () => {
  assert.equal(
    classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'),
    'desktop-Chrome'
  );
  assert.equal(
    classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'mobile-Safari'
  );
  assert.equal(
    classifyDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1'),
    'tablet-Safari'
  );
  assert.equal(
    classifyDevice('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'),
    'desktop-Firefox'
  );
});

test('classifyDevice never throws on missing/garbage input', () => {
  assert.equal(classifyDevice(undefined), 'desktop-Other');
  assert.equal(classifyDevice(''), 'desktop-Other');
});
