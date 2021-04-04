"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _assert = _interopRequireDefault(require("assert"));

var queryAST = _interopRequireWildcard(require("./query-ast-to-sql-ast"));

var _arrayToConnection = _interopRequireDefault(require("./array-to-connection"));

var _aliasNamespace = _interopRequireDefault(require("./alias-namespace"));

var _batchPlanner = _interopRequireDefault(require("./batch-planner"));

var _util = require("./util");

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

async function joinMonster(resolveInfo, context, dbCall, options = {}) {
  const sqlAST = queryAST.queryASTToSqlAST(resolveInfo, options, context);
  const {
    sql,
    shapeDefinition
  } = await (0, _util.compileSqlAST)(sqlAST, context, options);
  if (!sql) return {};
  let data = await (0, _util.handleUserDbCall)(dbCall, sql, sqlAST, shapeDefinition);
  data = (0, _arrayToConnection.default)(data, sqlAST);
  await (0, _batchPlanner.default)(sqlAST, data, dbCall, context, options);

  if (Array.isArray(data)) {
    const childrenToCheck = sqlAST.children.filter(child => child.sqlBatch);
    return data.filter(d => {
      for (const child of childrenToCheck) {
        if (d[child.fieldName] == null) {
          return false;
        }
      }

      return true;
    });
  }

  return data;
}

async function getNode(typeName, resolveInfo, context, condition, dbCall, options = {}) {
  const type = resolveInfo.schema._typeMap[typeName];
  (0, _assert.default)(type, `Type "${typeName}" not found in your schema.`);
  (0, _assert.default)((0, _util.getConfigFromSchemaObject)(type).sqlTable, `joinMonster can't fetch a ${typeName} as a Node unless it has "sqlTable" tagged.`);
  let where = (0, _util.buildWhereFunction)(type, condition, options);
  const fakeParentNode = {
    _fields: {
      node: {
        type,
        name: type.name.toLowerCase(),
        args: {},
        extensions: {
          joinMonster: {
            where
          }
        }
      }
    }
  };
  const namespace = new _aliasNamespace.default(options.minify);
  const sqlAST = {};
  const fieldNodes = resolveInfo.fieldNodes || resolveInfo.fieldASTs;
  queryAST.populateASTNode.call(resolveInfo, fieldNodes[0], fakeParentNode, sqlAST, namespace, 0, options, context);
  queryAST.pruneDuplicateSqlDeps(sqlAST, namespace);
  const {
    sql,
    shapeDefinition
  } = await (0, _util.compileSqlAST)(sqlAST, context, options);
  const data = (0, _arrayToConnection.default)(await (0, _util.handleUserDbCall)(dbCall, sql, sqlAST, shapeDefinition), sqlAST);
  await (0, _batchPlanner.default)(sqlAST, data, dbCall, context, options);
  if (!data) return data;
  data.__type__ = type;
  return data;
}

joinMonster.getNode = getNode;
joinMonster.version = require('../package.json').version;
var _default = joinMonster;
exports.default = _default;