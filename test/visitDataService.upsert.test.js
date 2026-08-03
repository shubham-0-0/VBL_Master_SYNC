const assert = require('assert');
const { normalizeOrderId, buildUpsertUpdateClause } = require('../services/visitDataService');

// normalizeOrderId
assert.strictEqual(normalizeOrderId('ORD123'), 'ORD123', 'real value passes through');
assert.strictEqual(normalizeOrderId(''), null, 'empty string becomes null');
assert.strictEqual(normalizeOrderId('   '), null, 'whitespace-only becomes null');
assert.strictEqual(normalizeOrderId(undefined), null, 'undefined becomes null');
assert.strictEqual(normalizeOrderId(null), null, 'null stays null');
assert.strictEqual(normalizeOrderId(0), 0, 'falsy non-string value passes through unchanged');

// buildUpsertUpdateClause
const columns = ['DIST_CD', 'VISIT_ID', 'ORDER_ID'];
const clause = buildUpsertUpdateClause(columns, 'ORDER_ID');
assert.strictEqual(
  clause,
  '`DIST_CD`=VALUES(`DIST_CD`), `VISIT_ID`=VALUES(`VISIT_ID`)',
  'excludes ORDER_ID and formats remaining columns'
);

const clauseNoExclusion = buildUpsertUpdateClause(['A', 'B'], 'NOT_PRESENT');
assert.strictEqual(
  clauseNoExclusion,
  '`A`=VALUES(`A`), `B`=VALUES(`B`)',
  'excluding a column not in the list changes nothing'
);

console.log('All visitDataService upsert helper tests passed');
