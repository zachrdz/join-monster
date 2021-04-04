"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.joinPrefix = joinPrefix;
exports.generateCastExpressionFromValueType = generateCastExpressionFromValueType;
exports.thisIsNotTheEndOfThisBatch = thisIsNotTheEndOfThisBatch;
exports.whereConditionIsntSupposedToGoInsideSubqueryOrOnNextBatch = whereConditionIsntSupposedToGoInsideSubqueryOrOnNextBatch;
exports.sortKeyToOrderings = sortKeyToOrderings;
exports.keysetPagingSelect = keysetPagingSelect;
exports.offsetPagingSelect = offsetPagingSelect;
exports.orderingsToString = orderingsToString;
exports.interpretForOffsetPaging = interpretForOffsetPaging;
exports.interpretForKeysetPaging = interpretForKeysetPaging;
exports.validateCursor = validateCursor;

var _assert = _interopRequireDefault(require("assert"));

var _lodash = require("lodash");

var _graphqlRelay = require("graphql-relay");

var _util = require("../util");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function joinPrefix(prefix) {
  return prefix.slice(1).map(name => name + '__').join('');
}

function generateCastExpressionFromValueType(key, val) {
  const castTypes = {
    string: 'TEXT'
  };
  const type = castTypes[typeof val] || null;

  if (type) {
    return `CAST(${key} AS ${type})`;
  }

  return key;
}

function doubleQuote(str) {
  return `"${str}"`;
}

function thisIsNotTheEndOfThisBatch(node, parent) {
  var _ref6;

  return !node.sqlBatch && !((_ref6 = node) != null ? (_ref6 = _ref6.junction) != null ? _ref6.sqlBatch : _ref6 : _ref6) || !parent;
}

function whereConditionIsntSupposedToGoInsideSubqueryOrOnNextBatch(node, parent) {
  var _ref5;

  return !node.paginate && (!(node.sqlBatch || ((_ref5 = node) != null ? (_ref5 = _ref5.junction) != null ? _ref5.sqlBatch : _ref5 : _ref5)) || !parent);
}

function sortKeyToOrderings(sortKey, args) {
  const orderColumns = [];
  let flip = false;

  if (args && args.last) {
    flip = true;
  }

  if (Array.isArray(sortKey)) {
    for (const {
      column,
      direction
    } of sortKey) {
      (0, _assert.default)(column, `Each "sortKey" array entry must have a 'column' and a 'direction' property`);
      let descending = direction.toUpperCase() === 'DESC';
      if (flip) descending = !descending;
      orderColumns.push({
        column,
        direction: descending ? 'DESC' : 'ASC'
      });
    }
  } else {
    (0, _assert.default)(sortKey.order, 'A "sortKey" object must have an "order"');
    let descending = sortKey.order.toUpperCase() === 'DESC';
    if (flip) descending = !descending;

    for (const column of (0, _util.wrap)(sortKey.key)) {
      orderColumns.push({
        column,
        direction: descending ? 'DESC' : 'ASC'
      });
    }
  }

  return orderColumns;
}

function keysetPagingSelect(table, whereCondition, order, limit, as, options = {}) {
  let {
    joinCondition,
    joinType,
    extraJoin,
    q
  } = options;
  q = q || doubleQuote;
  whereCondition = (0, _lodash.filter)(whereCondition).join(' AND ') || 'TRUE';

  if (joinCondition) {
    return `\
${joinType || ''} JOIN LATERAL (
  SELECT ${q(as)}.*
  FROM ${table} ${q(as)}
  ${extraJoin ? `LEFT JOIN ${extraJoin.name} ${q(extraJoin.as)}
    ON ${extraJoin.condition}` : ''}
  WHERE ${whereCondition}
  ORDER BY ${orderingsToString(order.columns, q, order.table)}
  LIMIT ${limit}
) ${q(as)} ON ${joinCondition}`;
  }

  return `\
FROM (
  SELECT ${q(as)}.*
  FROM ${table} ${q(as)}
  WHERE ${whereCondition}
  ORDER BY ${orderingsToString(order.columns, q, order.table)}
  LIMIT ${limit}
) ${q(as)}`;
}

function offsetPagingSelect(table, pagingWhereConditions, order, limit, offset, as, options = {}) {
  let {
    joinCondition,
    joinType,
    extraJoin,
    q
  } = options;
  q = q || doubleQuote;
  const whereCondition = (0, _lodash.filter)(pagingWhereConditions).join(' AND ') || 'TRUE';

  if (joinCondition) {
    return `\
${joinType || ''} JOIN LATERAL (
  SELECT ${q(as)}.*, count(*) OVER () AS ${q('$total')}
  FROM ${table} ${q(as)}
  ${extraJoin ? `LEFT JOIN ${extraJoin.name} ${q(extraJoin.as)}
    ON ${extraJoin.condition}` : ''}
  WHERE ${whereCondition}
  ORDER BY ${orderingsToString(order.columns, q, order.table)}
  LIMIT ${limit} OFFSET ${offset}
) ${q(as)} ON ${joinCondition}`;
  }

  return `\
FROM (
  SELECT ${q(as)}.*, count(*) OVER () AS ${q('$total')}
  FROM ${table} ${q(as)}
  WHERE ${whereCondition}
  ORDER BY ${orderingsToString(order.columns, q, order.table)}
  LIMIT ${limit} OFFSET ${offset}
) ${q(as)}`;
}

function orderingsToString(orderings, q, as) {
  const orderByClauses = [];

  for (const ordering of orderings) {
    orderByClauses.push(`${as ? q(as) + '.' : ''}${q(ordering.column)} ${ordering.direction}`);
  }

  return orderByClauses.join(', ');
}

function interpretForOffsetPaging(node, dialect) {
  var _ref3, _ref4;

  const {
    name
  } = dialect;

  if ((_ref4 = node) != null ? (_ref4 = _ref4.args) != null ? _ref4.last : _ref4 : _ref4) {
    throw new Error('Backward pagination not supported with offsets. Consider using keyset pagination instead');
  }

  const order = {};

  if (node.orderBy) {
    order.table = node.as;
    order.columns = node.orderBy;
  } else {
    order.table = node.junction.as;
    order.columns = node.junction.orderBy;
  }

  let limit = ['mariadb', 'mysql', 'oracle'].includes(name) ? '18446744073709551615' : 'ALL';
  let offset = 0;

  if ((_ref3 = node) != null ? (_ref3 = _ref3.args) != null ? _ref3.first : _ref3 : _ref3) {
    limit = parseInt(node.args.first, 10);

    if (node.paginate) {
      limit++;
    }

    if (node.args.after) {
      offset = (0, _graphqlRelay.cursorToOffset)(node.args.after) + 1;
    }
  }

  return {
    limit,
    offset,
    order
  };
}

function interpretForKeysetPaging(node, dialect) {
  var _ref, _ref2;

  const {
    name
  } = dialect;
  let sortTable;
  let sortKey;

  if (node.sortKey) {
    sortKey = node.sortKey;
    sortTable = node.as;
  } else {
    sortKey = node.junction.sortKey;
    sortTable = node.junction.as;
  }

  const order = {
    table: sortTable,
    columns: sortKeyToOrderings(sortKey, node.args)
  };
  const cursorKeys = order.columns.map(ordering => ordering.column);
  let limit = ['mariadb', 'mysql', 'oracle'].includes(name) ? '18446744073709551615' : 'ALL';
  let whereCondition = '';

  if ((_ref2 = node) != null ? (_ref2 = _ref2.args) != null ? _ref2.first : _ref2 : _ref2) {
    limit = parseInt(node.args.first, 10) + 1;

    if (node.args.after) {
      const cursorObj = (0, _util.cursorToObj)(node.args.after);
      validateCursor(cursorObj, cursorKeys);
      whereCondition = sortKeyToWhereCondition(cursorObj, order.columns, sortTable, dialect);
    }

    if (node.args.before) {
      throw new Error('Using "before" with "first" is nonsensical.');
    }
  } else if ((_ref = node) != null ? (_ref = _ref.args) != null ? _ref.last : _ref : _ref) {
    limit = parseInt(node.args.last, 10) + 1;

    if (node.args.before) {
      const cursorObj = (0, _util.cursorToObj)(node.args.before);
      validateCursor(cursorObj, cursorKeys);
      whereCondition = sortKeyToWhereCondition(cursorObj, order.columns, sortTable, dialect);
    }

    if (node.args.after) {
      throw new Error('Using "after" with "last" is nonsensical.');
    }
  }

  return {
    limit,
    order,
    whereCondition
  };
}

function validateCursor(cursorObj, expectedKeys) {
  const actualKeys = Object.keys(cursorObj);
  const expectedKeySet = new Set(expectedKeys);
  const actualKeySet = new Set(actualKeys);

  for (let key of actualKeys) {
    if (!expectedKeySet.has(key)) {
      throw new Error(`Invalid cursor. The column "${key}" is not in the sort key.`);
    }
  }

  for (let key of expectedKeys) {
    if (!actualKeySet.has(key)) {
      throw new Error(`Invalid cursor. The column "${key}" is not in the cursor.`);
    }
  }
}

function sortKeyToWhereCondition(keyObj, orderings, sortTable, dialect) {
  const condition = (ordering, operator) => {
    operator = operator || (ordering.direction === 'DESC' ? '<' : '>');
    return `${dialect.quote(sortTable)}.${dialect.quote(ordering.column)} ${operator} ${(0, _util.maybeQuote)(keyObj[ordering.column], dialect.name)}`;
  };

  orderings = [...orderings];
  return '(' + orderings.reduceRight((agg, ordering) => {
    return `
      ${condition(ordering)}
      OR (${condition(ordering, '=')} AND ${agg})`;
  }, condition(orderings.pop())) + ')';
}