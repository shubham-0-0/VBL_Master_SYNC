const assert = require('assert');
const { normalizeOrderId } = require('../services/visitDataService');

// normalizeOrderId
assert.strictEqual(normalizeOrderId('ORD123'), 'ORD123', 'real value passes through');
assert.strictEqual(normalizeOrderId(''), null, 'empty string becomes null');
assert.strictEqual(normalizeOrderId('   '), null, 'whitespace-only becomes null');
assert.strictEqual(normalizeOrderId(undefined), null, 'undefined becomes null');
assert.strictEqual(normalizeOrderId(null), null, 'null stays null');
assert.strictEqual(normalizeOrderId(0), 0, 'falsy non-string value passes through unchanged');

console.log('All visitDataService normalizeOrderId tests passed');
