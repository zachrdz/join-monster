"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _lodash = require("lodash");

var _arrayToConnection = _interopRequireDefault(require("../array-to-connection"));

var _util = require("../util");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

async function nextBatch(sqlAST, data, dbCall, context, options) {
  if (sqlAST.paginate) {
    if (Array.isArray(data)) {
      data = (0, _lodash.chain)(data).flatMap('edges').map('node').value();
    } else {
      data = (0, _lodash.map)(data.edges, 'node');
    }
  }

  if (!data || Array.isArray(data) && data.length === 0) {
    return;
  }

  const children = sqlAST.children;
  Object.values(sqlAST.typedChildren || {}).forEach(typedChildren => children.push(...typedChildren));
  return Promise.all(children.map(childAST => nextBatchChild(childAST, data, dbCall, context, options)));
}

async function nextBatchChild(childAST, data, dbCall, context, options) {
  var _ref2;

  if (childAST.type !== 'table' && childAST.type !== 'union') return;
  const fieldName = childAST.fieldName;

  if (childAST.sqlBatch || ((_ref2 = childAST) != null ? (_ref2 = _ref2.junction) != null ? _ref2.sqlBatch : _ref2 : _ref2)) {
    var _ref;

    let thisKey;
    let parentKey;

    if (childAST.sqlBatch) {
      childAST.children.push(childAST.sqlBatch.thisKey);
      thisKey = childAST.sqlBatch.thisKey.fieldName;
      parentKey = childAST.sqlBatch.parentKey.fieldName;
    } else if ((_ref = childAST) != null ? (_ref = _ref.junction) != null ? _ref.sqlBatch : _ref : _ref) {
      childAST.children.push(childAST.junction.sqlBatch.thisKey);
      thisKey = childAST.junction.sqlBatch.thisKey.fieldName;
      parentKey = childAST.junction.sqlBatch.parentKey.fieldName;
    }

    if (Array.isArray(data)) {
      const batchScope = (0, _lodash.uniq)(data.map(obj => (0, _util.maybeQuote)(obj[parentKey])));
      const {
        sql,
        shapeDefinition
      } = await (0, _util.compileSqlAST)(childAST, context, { ...options,
        batchScope
      });
      let newData = await (0, _util.handleUserDbCall)(dbCall, sql, childAST, (0, _util.wrap)(shapeDefinition));
      newData = (0, _lodash.groupBy)(newData, thisKey);

      if (childAST.paginate) {
        (0, _lodash.forIn)(newData, (group, key, obj) => {
          obj[key] = (0, _arrayToConnection.default)(group, childAST);
        });
      }

      if (childAST.grabMany) {
        for (let obj of data) {
          obj[fieldName] = newData[obj[parentKey]] || (childAST.paginate ? {
            total: 0,
            edges: []
          } : []);
        }
      } else {
        let matchedData = [];

        for (let obj of data) {
          const ob = newData[obj[parentKey]];

          if (ob) {
            obj[fieldName] = (0, _arrayToConnection.default)(newData[obj[parentKey]][0], childAST);
            matchedData.push(obj);
          } else {
            obj[fieldName] = null;
          }
        }

        data = matchedData;
      }

      const nextLevelData = (0, _lodash.chain)(data).filter(obj => obj != null).flatMap(obj => obj[fieldName]).filter(obj => obj != null).value();
      return nextBatch(childAST, nextLevelData, dbCall, context, options);
    }

    const batchScope = [(0, _util.maybeQuote)(data[parentKey])];
    const {
      sql,
      shapeDefinition
    } = await (0, _util.compileSqlAST)(childAST, context, { ...options,
      batchScope
    });
    let newData = await (0, _util.handleUserDbCall)(dbCall, sql, childAST, (0, _util.wrap)(shapeDefinition));
    newData = (0, _lodash.groupBy)(newData, thisKey);

    if (childAST.paginate) {
      const targets = newData[data[parentKey]];
      data[fieldName] = (0, _arrayToConnection.default)(targets, childAST);
    } else if (childAST.grabMany) {
      data[fieldName] = newData[data[parentKey]] || [];
    } else {
      const targets = newData[data[parentKey]] || [];
      data[fieldName] = targets[0];
    }

    if (data) {
      return nextBatch(childAST, data[fieldName], dbCall, context, options);
    }
  } else if (Array.isArray(data)) {
    const nextLevelData = (0, _lodash.chain)(data).filter(obj => obj != null).flatMap(obj => obj[fieldName]).filter(obj => obj != null).value();
    return nextBatch(childAST, nextLevelData, dbCall, context, options);
  } else if (data) {
    return nextBatch(childAST, data[fieldName], dbCall, context, options);
  }
}

var _default = nextBatch;
exports.default = _default;