import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_TOOLS } from '../src/policy/restrictions.js';

test('every tier can send its own memory card', () => {
  for (const tier of ['owner-group', 'member', 'member-group']) {
    assert.equal(TIER_TOOLS[tier].includes('memory_card_send'), true, tier);
  }
});

test('every tier can record an impression, guests included', () => {
  for (const tier of ['owner-group', 'member', 'member-group']) {
    assert.equal(TIER_TOOLS[tier].includes('memory_note'), true, `${tier} must be able to write notes`);
  }
});

test('group tiers can ask for the digest, DMs cannot', () => {
  assert.equal(TIER_TOOLS['owner-group'].includes('group_digest'), true);
  assert.equal(TIER_TOOLS['member-group'].includes('group_digest'), true);
  assert.equal(TIER_TOOLS.member.includes('group_digest'), false);
});

test('guest tiers never see shell or filesystem tools', () => {
  for (const tier of ['member', 'member-group']) {
    for (const forbidden of ['pwsh', 'write', 'edit', 'read_file']) {
      assert.equal(TIER_TOOLS[tier].includes(forbidden), false, `${tier} must not allow ${forbidden}`);
    }
  }
});

test('the admin loses filesystem tools inside groups', () => {
  for (const forbidden of ['read', 'glob', 'grep', 'read_image', 'pwsh', 'write']) {
    assert.equal(TIER_TOOLS['owner-group'].includes(forbidden), false, `${forbidden} must stay out of groups`);
  }
  for (const allowed of ['web_search', 'qq_send', 'memory_note']) {
    assert.equal(TIER_TOOLS['owner-group'].includes(allowed), true, allowed);
  }
});
