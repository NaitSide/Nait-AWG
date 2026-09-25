'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectContainer } = require('../scripts/selfhost-preflight');

test('selects a single supported AWG container', () => {
  assert.equal(selectContainer(['unrelated', 'amnezia-awg2']), 'amnezia-awg2');
  assert.equal(selectContainer(['amnezia-awg']), 'amnezia-awg');
});

test('rejects missing or ambiguous AWG containers', () => {
  assert.throws(() => selectContainer(['unrelated']), /exactly one/);
  assert.throws(() => selectContainer(['amnezia-awg', 'amnezia-awg2']), /exactly one/);
});
