import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toImageSource } from '../src/tools/send.js';

test('toImageSource keeps URLs and base64 payloads untouched', () => {
  assert.equal(toImageSource('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(toImageSource('http://example.com/a.png'), 'http://example.com/a.png');
  assert.equal(toImageSource('base64://AAAA'), 'base64://AAAA');
});

test('toImageSource turns Windows paths into file URIs', () => {
  assert.equal(toImageSource('E:\\work\\qq-bridge\\out.png'), 'file:///E:/work/qq-bridge/out.png');
  assert.equal(toImageSource('E:/work/qq-bridge/out.png'), 'file:///E:/work/qq-bridge/out.png');
});

test('toImageSource trims whitespace', () => {
  assert.equal(toImageSource('  E:\\tmp\\x.png  '), 'file:///E:/tmp/x.png');
});
