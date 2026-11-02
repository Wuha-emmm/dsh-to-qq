import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toImageSource, registerQqSendTool } from '../src/tools/send.js';

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

/**
 * Minimal harness: capture the tool and give it a bridge whose session is bound.
 *
 * @param {{ queue: any[], sent: any[] }} log Collector.
 * @returns {any} Registered tool.
 */
function register(log) {
  let tool;
  const bridge = {
    client: { call: async (action, params) => { log.sent.push({ action, params }); return {}; } },
    sessionContext: () => ({ qq: 1, scene: 'dm:1', tier: 'owner' }),
    queueMedia: (scene, item) => log.queue.push({ scene, item }),
    recordSceneOutbound: () => {},
  };
  registerQqSendTool({ tools: { register: value => { tool = value; return () => {}; } } }, { bridge, log: () => {} });
  return tool;
}

test('a picture with a caption waits for the reply', async () => {
  const log = { queue: [], sent: [] };
  const tool = register(log);
  const result = await tool.execute({ text: '特勤处', image: 'E:\\tmp\\a.png' }, { agent: { id: 's1' } });
  assert.equal(result.queued, true);
  assert.equal(log.queue.length, 1);
  assert.deepEqual(log.queue[0].item, { caption: '特勤处', image: 'E:\\tmp\\a.png', file: '' });
  assert.equal(log.sent.length, 0);
});

test('a long caption is kept whole and merged with the reply', async () => {
  const log = { queue: [], sent: [] };
  const tool = register(log);
  const long = '特勤处到了：技术中心 Lv.3、工作台 Lv.3、制药台 Lv.3、防具台 Lv.3，右边仓库 Lv.10';
  const result = await tool.execute({ text: long, image: 'E:\\tmp\\a.png' }, { agent: { id: 's1' } });
  assert.doesNotMatch(result.report, /超过 30 字/);
  assert.equal(log.queue[0].item.caption, long);
});

test('a picture without text goes out immediately', async () => {
  const log = { queue: [], sent: [] };
  const tool = register(log);
  const result = await tool.execute({ image: 'E:\\tmp\\a.png' }, { agent: { id: 's1' } });
  assert.equal(result.queued, undefined);
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].action, 'send_private_msg');
  assert.deepEqual(log.sent[0].params.message[0].type, 'image');
});
