import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/bridge/commands.js';
import { mergeConfig, defaults } from '../src/config/defaults.js';
import { generateImage } from '../src/image/ark.js';

test('/画 is a command with the prompt as its argument', () => {
  assert.deepEqual(parseCommand('/画 一只戴不锈钢盆的鲸鱼娘'), { name: 'draw', arg: '一只戴不锈钢盆的鲸鱼娘' });
  assert.deepEqual(parseCommand('/画图 猫'), { name: 'draw', arg: '猫' });
  assert.deepEqual(parseCommand('/生图 --size 2K 猫'), { name: 'draw', arg: '--size 2K 猫' });
  assert.deepEqual(parseCommand('/draw a cat'), { name: 'draw', arg: 'a cat' });
  assert.deepEqual(parseCommand('/imagine 鲸鱼'), { name: 'draw', arg: '鲸鱼' });
  assert.deepEqual(parseCommand('/画'), { name: 'draw', arg: '' });
});

test('the image section has working defaults', () => {
  const config = defaults();
  assert.equal(config.image.provider, 'ark');
  assert.equal(config.image.apiKey, '');
  assert.equal(config.image.model, 'doubao-seedream-5-0-flash-260915');
  assert.equal(config.image.size, '1024x1024');
  assert.equal(config.image.watermark, false);
});

test('mergeConfig keeps a stored key and fills the rest', () => {
  const config = mergeConfig({ image: { apiKey: 'ark-test', model: 'doubao-seedream-5-5-261028' } });
  assert.equal(config.image.apiKey, 'ark-test');
  assert.equal(config.image.model, 'doubao-seedream-5-5-261028');
  assert.equal(config.image.size, '1024x1024');
  assert.equal(config.image.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
});

test('mergeConfig repairs a mangled image section', () => {
  const config = mergeConfig({ image: { provider: 'openai', watermark: 'yes', size: 42 } });
  assert.equal(config.image.provider, 'ark');
  assert.equal(config.image.watermark, false);
  assert.equal(config.image.size, '1024x1024');
  assert.equal(mergeConfig({ image: 'nope' }).image.model, 'doubao-seedream-5-0-flash-260915');
});

test('generateImage refuses to call out without a key, model, or prompt', async () => {
  await assert.rejects(() => generateImage({ apiKey: '', model: 'm', prompt: 'p' }), /图还没配 key/);
  await assert.rejects(() => generateImage({ apiKey: 'k', model: '', prompt: 'p' }), /模型名/);
  await assert.rejects(() => generateImage({ apiKey: 'k', model: 'm', prompt: '  ' }), /要画什么/);
});
