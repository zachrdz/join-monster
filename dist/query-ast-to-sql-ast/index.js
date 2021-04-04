"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.queryASTToSqlAST = queryASTToSqlAST;
exports.populateASTNode = populateASTNode;
exports.pruneDuplicateSqlDeps = pruneDuplicateSqlDeps;
exports.handleOrderBy = handleOrderBy;

var _assert = _interopRequireDefault(require("assert"));

var _lodash = require("lodash");

var _deprecate = _interopRequireDefault(require("deprecate"));

var _values = require("graphql/execution/values");

var _aliasNamespace = _interopRequireDefault(require("../alias-namespace"));

var _util = require("../util");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class SQLASTNode {
  constructor(parentNode, props) {
    Object.defineProperty(this, 'parent', {
      enumerable: false,
      value: parentNode
    });

    for (let prop in props) {
      this[prop] = props[prop];
    }
  }

}

const TABLE_TYPES = ['GraphQLObjectType', 'GraphQLUnionType', 'GraphQLInterfaceType'];

function mergeAll(fieldNodes) {
  const newFieldNodes = [...fieldNodes];

  while (newFieldNodes.length > 1) {
    newFieldNodes.push(merge(newFieldNodes.pop(), newFieldNodes.pop()));
  }

  return newFieldNodes;
}

function merge(dest, src) {
  return { ...dest,
    selectionSet: { ...dest.selectionSet,
      selections: [...dest.selectionSet.selections, ...src.selectionSet.selections]
    }
  };
}

function queryASTToSqlAST(resolveInfo, options, context) {
  const namespace = new _aliasNamespace.default(options.dialect === 'oracle' ? true : options.minify);
  const sqlAST = {};
  let fieldNodes = resolveInfo.fieldNodes || resolveInfo.fieldASTs;
  fieldNodes = mergeAll(fieldNodes);

  _assert.default.equal(fieldNodes.length, 1, 'We thought this would always have a length of 1. FIX ME!!');

  const queryAST = fieldNodes[0];
  const parentType = resolveInfo.parentType;
  populateASTNode.call(resolveInfo, queryAST, parentType, sqlAST, namespace, 0, options, context);

  _assert.default.ok(['table', 'union'].indexOf(sqlAST.type) > -1, 'Must call joinMonster in a resolver on a field where the type is decorated with "sqlTable".');

  pruneDuplicateSqlDeps(sqlAST, namespace);
  return sqlAST;
}

function populateASTNode(queryASTNode, parentTypeNode, sqlASTNode, namespace, depth, options, context) {
  var _ref5;

  const fieldName = queryASTNode.name.value;

  if (/^__/.test(fieldName)) {
    sqlASTNode.type = 'noop';
    return;
  }

  let field = parentTypeNode._fields[fieldName];

  if (!field) {
    throw new Error(`The field "${fieldName}" is not in the ${parentTypeNode.name} type.`);
  }

  let fieldIncludes;

  if ((_ref5 = sqlASTNode) != null ? (_ref5 = _ref5.parent) != null ? (_ref5 = _ref5.junction) != null ? (_ref5 = _ref5.include) != null ? _ref5[fieldName] : _ref5 : _ref5 : _ref5 : _ref5) {
    fieldIncludes = sqlASTNode.parent.junction.include[fieldName];
    field = { ...field,
      extensions: { ...(field.extensions || {}),
        joinMonster: { ...(0, _util.getConfigFromSchemaObject)(field),
          ...fieldIncludes
        }
      }
    };
    sqlASTNode.fromOtherTable = sqlASTNode.parent.junction.as;
  }

  const fieldConfig = (0, _util.getConfigFromSchemaObject)(field);

  if (fieldConfig.ignoreAll) {
    sqlASTNode.type = 'noop';
    return;
  }

  let grabMany = false;
  let gqlType = stripNonNullType(field.type);
  sqlASTNode.args = (0, _values.getArgumentValues)(field, queryASTNode, this.variableValues);

  if (gqlType.constructor.name === 'GraphQLList') {
    gqlType = stripNonNullType(gqlType.ofType);
    grabMany = true;
  }

  if (gqlType.constructor.name === 'GraphQLObjectType' && gqlType._fields.edges && gqlType._fields.pageInfo) {
    grabMany = true;
    const stripped = stripRelayConnection(gqlType, queryASTNode, this.fragments);
    gqlType = stripNonNullType(stripped.gqlType);
    queryASTNode = stripped.queryASTNode;

    if (fieldConfig.sqlPaginate) {
      sqlASTNode.paginate = true;
    }
  } else if (fieldConfig.sqlPaginate) {
    throw new Error(`To paginate the ${gqlType.name} type, it must be a GraphQLObjectType that fulfills the relay spec.
      The type must have a "pageInfo" and "edges" field. https://facebook.github.io/relay/graphql/connections.htm`);
  }

  const config = (0, _util.getConfigFromSchemaObject)(gqlType);

  if (!fieldConfig.ignoreTable && TABLE_TYPES.includes(gqlType.constructor.name) && config.sqlTable) {
    if (depth >= 1) {
      (0, _assert.default)(!fieldConfig.junctionTable, '"junctionTable" has been replaced with a new API.');
      (0, _assert.default)(fieldConfig.sqlJoin || fieldConfig.sqlBatch || fieldConfig.junction, `If an Object type maps to a SQL table and has a child which is another Object type that also maps to a SQL table,
        you must define "sqlJoin", "sqlBatch", or "junction" on that field's extensions to tell joinMonster how to fetch it.
        Or you can ignore it with "ignoreTable".
        Check the extensions.joinMonster property of "${fieldName}" field on the "${parentTypeNode.name}" type.`);
    }

    handleTable.call(this, sqlASTNode, queryASTNode, field, gqlType, namespace, grabMany, depth, options, context);
  } else if (fieldConfig.sqlExpr) {
    sqlASTNode.type = 'expression';
    sqlASTNode.sqlExpr = fieldConfig.sqlExpr;
    let aliasFrom = sqlASTNode.fieldName = field.name;

    if (sqlASTNode.defferedFrom) {
      aliasFrom += '@' + parentTypeNode.name;
    }

    sqlASTNode.as = namespace.generate('column', aliasFrom);
  } else if (fieldConfig.sqlDeps) {
    sqlASTNode.type = 'columnDeps';
    sqlASTNode.names = fieldConfig.sqlDeps;
  } else if (fieldConfig.sqlColumn || ['GraphQLObjectType', 'GraphQLInterfaceType'].includes(parentTypeNode.constructor.name)) {
    sqlASTNode.type = 'column';
    sqlASTNode.name = fieldConfig.sqlColumn || field.name;
    let aliasFrom = sqlASTNode.fieldName = field.name;

    if (sqlASTNode.defferedFrom) {
      aliasFrom += '@' + parentTypeNode.name;
    }

    sqlASTNode.as = namespace.generate('column', aliasFrom);
  } else {
    sqlASTNode.type = 'noop';
  }
}

function handleTable(sqlASTNode, queryASTNode, field, gqlType, namespace, grabMany, depth, options, context) {
  const config = (0, _util.getConfigFromSchemaObject)(gqlType);
  const fieldConfig = (0, _util.getConfigFromSchemaObject)(field);
  sqlASTNode.type = 'table';
  const sqlTable = (0, _util.unthunk)(config.sqlTable, sqlASTNode.args || {}, context);
  sqlASTNode.name = sqlTable;
  sqlASTNode.as = namespace.generate('table', field.name);

  if (fieldConfig.orderBy && !sqlASTNode.orderBy) {
    sqlASTNode.orderBy = handleOrderBy((0, _util.unthunk)(fieldConfig.orderBy, sqlASTNode.args || {}, context));
  }

  const children = sqlASTNode.children = sqlASTNode.children || [];
  sqlASTNode.fieldName = field.name;
  sqlASTNode.grabMany = grabMany;

  if (fieldConfig.where) {
    sqlASTNode.where = fieldConfig.where;
  }

  if (fieldConfig.sqlJoin) {
    sqlASTNode.sqlJoin = fieldConfig.sqlJoin;
  } else if (fieldConfig.junction) {
    const junctionTable = (0, _util.unthunk)((0, _util.ensure)(fieldConfig.junction, 'sqlTable'), sqlASTNode.args || {}, context);
    const junction = sqlASTNode.junction = {
      sqlTable: junctionTable,
      as: namespace.generate('table', junctionTable)
    };

    if (fieldConfig.junction.include) {
      junction.include = (0, _util.unthunk)(fieldConfig.junction.include, sqlASTNode.args || {}, context);
    }

    if (fieldConfig.junction.orderBy) {
      junction.orderBy = handleOrderBy((0, _util.unthunk)(fieldConfig.junction.orderBy, sqlASTNode.args || {}, context));
    }

    if (fieldConfig.junction.where) {
      junction.where = fieldConfig.junction.where;
    }

    if (fieldConfig.junction.sqlJoins) {
      junction.sqlJoins = fieldConfig.junction.sqlJoins;
    } else if (fieldConfig.junction.sqlBatch) {
      children.push({ ...keyToASTChild((0, _util.ensure)(fieldConfig.junction, 'uniqueKey'), namespace),
        fromOtherTable: junction.as
      });
      junction.sqlBatch = {
        sqlJoin: (0, _util.ensure)(fieldConfig.junction.sqlBatch, 'sqlJoin'),
        thisKey: { ...columnToASTChild((0, _util.ensure)(fieldConfig.junction.sqlBatch, 'thisKey'), namespace),
          fromOtherTable: junction.as
        },
        parentKey: columnToASTChild((0, _util.ensure)(fieldConfig.junction.sqlBatch, 'parentKey'), namespace)
      };
    } else {
      throw new Error('junction requires either a `sqlJoins` or `sqlBatch`');
    }
  } else if (fieldConfig.sqlBatch) {
    sqlASTNode.sqlBatch = {
      thisKey: columnToASTChild((0, _util.ensure)(fieldConfig.sqlBatch, 'thisKey'), namespace),
      parentKey: columnToASTChild((0, _util.ensure)(fieldConfig.sqlBatch, 'parentKey'), namespace)
    };
  }

  if (fieldConfig.limit) {
    (0, _assert.default)(fieldConfig.orderBy, '`orderBy` is required with `limit`');
    sqlASTNode.limit = (0, _util.unthunk)(fieldConfig.limit, sqlASTNode.args || {}, context);
  }

  if (sqlASTNode.paginate) {
    getSortColumns(field, sqlASTNode, context);
  }

  children.push(keyToASTChild((0, _util.ensure)(config, 'uniqueKey'), namespace));

  if (config.alwaysFetch) {
    for (let column of (0, _util.wrap)(config.alwaysFetch)) {
      children.push(columnToASTChild((0, _util.unthunk)(column, sqlASTNode.as, sqlASTNode.args || {}, context, sqlASTNode), namespace));
    }
  }

  if (config.typeHint && ['GraphQLUnionType', 'GraphQLInterfaceType'].includes(gqlType.constructor.name)) {
    (0, _deprecate.default)('`typeHint` is deprecated. Use `alwaysFetch` instead.');
    children.push(columnToASTChild(config.typeHint, namespace));
  }

  if (sqlASTNode.paginate) {
    handleColumnsRequiredForPagination(sqlASTNode, namespace);
  }

  if (queryASTNode.selectionSet) {
    if (gqlType.constructor.name === 'GraphQLUnionType' || gqlType.constructor.name === 'GraphQLInterfaceType') {
      sqlASTNode.type = 'union';
      sqlASTNode.typedChildren = {};
      handleUnionSelections.call(this, sqlASTNode, children, queryASTNode.selectionSet.selections, gqlType, namespace, depth, options, context);
    } else {
      handleSelections.call(this, sqlASTNode, children, queryASTNode.selectionSet.selections, gqlType, namespace, depth, options, context);
    }
  }
}

function handleUnionSelections(sqlASTNode, children, selections, gqlType, namespace, depth, options, context, internalOptions = {}) {
  for (let selection of selections) {
    switch (selection.kind) {
      case 'Field':
        const existingNode = children.find(child => child.fieldName === selection.name.value && child.type === 'table');
        let newNode = new SQLASTNode(sqlASTNode);

        if (existingNode) {
          newNode = existingNode;
        } else {
          children.push(newNode);
        }

        if (internalOptions.defferedFrom) {
          newNode.defferedFrom = internalOptions.defferedFrom;
        }

        populateASTNode.call(this, selection, gqlType, newNode, namespace, depth + 1, options, context);
        break;

      case 'InlineFragment':
        {
          const selectionNameOfType = selection.typeCondition.name.value;
          const deferredType = this.schema._typeMap[selectionNameOfType];
          const deferToObjectType = deferredType.constructor.name === 'GraphQLObjectType';
          const handler = deferToObjectType ? handleSelections : handleUnionSelections;

          if (deferToObjectType) {
            const typedChildren = sqlASTNode.typedChildren;
            children = typedChildren[deferredType.name] = typedChildren[deferredType.name] || [];
            internalOptions.defferedFrom = gqlType;
          }

          handler.call(this, sqlASTNode, children, selection.selectionSet.selections, deferredType, namespace, depth, options, context, internalOptions);
        }
        break;

      case 'FragmentSpread':
        {
          const fragmentName = selection.name.value;
          const fragment = this.fragments[fragmentName];
          const fragmentNameOfType = fragment.typeCondition.name.value;
          const deferredType = this.schema._typeMap[fragmentNameOfType];
          const deferToObjectType = deferredType.constructor.name === 'GraphQLObjectType';
          const handler = deferToObjectType ? handleSelections : handleUnionSelections;

          if (deferToObjectType) {
            const typedChildren = sqlASTNode.typedChildren;
            children = typedChildren[deferredType.name] = typedChildren[deferredType.name] || [];
            internalOptions.defferedFrom = gqlType;
          }

          handler.call(this, sqlASTNode, children, fragment.selectionSet.selections, deferredType, namespace, depth, options, context, internalOptions);
        }
        break;

      default:
        throw new Error('Unknown selection kind: ' + selection.kind);
    }
  }
}

function handleSelections(sqlASTNode, children, selections, gqlType, namespace, depth, options, context, internalOptions = {}) {
  for (let selection of selections) {
    switch (selection.kind) {
      case 'Field':
        const existingNode = children.find(child => child.fieldName === selection.name.value && child.type === 'table');
        let newNode = new SQLASTNode(sqlASTNode);

        if (existingNode) {
          newNode = existingNode;
        } else {
          children.push(newNode);
        }

        if (internalOptions.defferedFrom) {
          newNode.defferedFrom = internalOptions.defferedFrom;
        }

        populateASTNode.call(this, selection, gqlType, newNode, namespace, depth + 1, options, context);
        break;

      case 'InlineFragment':
        {
          const selectionNameOfType = selection.typeCondition.name.value;
          const sameType = selectionNameOfType === gqlType.name;
          const interfaceType = (gqlType._interfaces || []).map(iface => iface.name).includes(selectionNameOfType);

          if (sameType || interfaceType) {
            handleSelections.call(this, sqlASTNode, children, selection.selectionSet.selections, gqlType, namespace, depth, options, context, internalOptions);
          }
        }
        break;

      case 'FragmentSpread':
        {
          const fragmentName = selection.name.value;
          const fragment = this.fragments[fragmentName];
          const fragmentNameOfType = fragment.typeCondition.name.value;
          const sameType = fragmentNameOfType === gqlType.name;
          const interfaceType = gqlType._interfaces.map(iface => iface.name).indexOf(fragmentNameOfType) >= 0;

          if (sameType || interfaceType) {
            handleSelections.call(this, sqlASTNode, children, fragment.selectionSet.selections, gqlType, namespace, depth, options, context, internalOptions);
          }
        }
        break;

      default:
        throw new Error('Unknown selection kind: ' + selection.kind);
    }
  }
}

function columnToASTChild(columnName, namespace) {
  return {
    type: 'column',
    name: columnName,
    fieldName: columnName,
    as: namespace.generate('column', columnName)
  };
}

function toClumsyName(keyArr) {
  return keyArr.map(name => name.slice(0, 3)).join('#');
}

function keyToASTChild(key, namespace) {
  if (typeof key === 'string') {
    return columnToASTChild(key, namespace);
  }

  if (Array.isArray(key)) {
    const clumsyName = toClumsyName(key);
    return {
      type: 'composite',
      name: key,
      fieldName: clumsyName,
      as: namespace.generate('column', clumsyName)
    };
  }
}

function handleColumnsRequiredForPagination(sqlASTNode, namespace) {
  var _ref3, _ref4;

  if (sqlASTNode.sortKey || ((_ref4 = sqlASTNode) != null ? (_ref4 = _ref4.junction) != null ? _ref4.sortKey : _ref4 : _ref4)) {
    const sortKey = sqlASTNode.sortKey || sqlASTNode.junction.sortKey;

    for (let column of (0, _util.sortKeyColumns)(sortKey)) {
      const newChild = columnToASTChild(column, namespace);

      if (!sqlASTNode.sortKey) {
        newChild.fromOtherTable = sqlASTNode.junction.as;
      }

      sqlASTNode.children.push(newChild);
    }
  } else if (sqlASTNode.orderBy || ((_ref3 = sqlASTNode) != null ? (_ref3 = _ref3.junction) != null ? _ref3.orderBy : _ref3 : _ref3)) {
    const newChild = columnToASTChild('$total', namespace);

    if (sqlASTNode.junction) {
      newChild.fromOtherTable = sqlASTNode.junction.as;
    }

    sqlASTNode.children.push(newChild);
  }
}

function stripRelayConnection(gqlType, queryASTNode, fragments) {
  const edgeType = stripNonNullType(gqlType._fields.edges.type);
  const strippedType = stripNonNullType(stripNonNullType(edgeType.ofType)._fields.node.type);
  const args = queryASTNode.arguments;
  const edges = spreadFragments(queryASTNode.selectionSet.selections, fragments, gqlType.name).find(selection => selection.name.value === 'edges');

  if (edges) {
    queryASTNode = spreadFragments(edges.selectionSet.selections, fragments, gqlType.name).find(selection => selection.name.value === 'node') || {};
  } else {
    queryASTNode = {};
  }

  queryASTNode.arguments = args;
  return {
    gqlType: strippedType,
    queryASTNode
  };
}

function stripNonNullType(type) {
  return type.constructor.name === 'GraphQLNonNull' ? type.ofType : type;
}

function pruneDuplicateSqlDeps(sqlAST, namespace) {
  const childrenToLoopOver = [];

  if (sqlAST.children) {
    childrenToLoopOver.push(sqlAST.children);
  }

  if (sqlAST.typedChildren) {
    childrenToLoopOver.push(...Object.values(sqlAST.typedChildren));
  }

  for (let children of childrenToLoopOver) {
    const depsByTable = {};

    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];

      if (child.type === 'columnDeps') {
        const keyName = child.fromOtherTable || '';
        child.names.forEach(name => {
          if (!depsByTable[keyName]) {
            depsByTable[keyName] = new Set();
          }

          depsByTable[keyName].add(name);
        });
        children.splice(i, 1);
      } else if (child.type === 'table' || child.type === 'union') {
        pruneDuplicateSqlDeps(child, namespace);
      }
    }

    for (let table in depsByTable) {
      const newNode = new SQLASTNode(sqlAST, {
        type: 'columnDeps',
        names: {},
        fromOtherTable: table || null
      });
      depsByTable[table].forEach(name => {
        newNode.names[name] = namespace.generate('column', name);
      });
      children.push(newNode);
    }
  }
}

function getSortColumns(field, sqlASTNode, context) {
  var _ref, _ref2;

  const fieldConfig = (0, _util.getConfigFromSchemaObject)(field);

  if (fieldConfig.sortKey) {
    sqlASTNode.sortKey = (0, _util.unthunk)(fieldConfig.sortKey, sqlASTNode.args || {}, context);
  }

  if (fieldConfig.orderBy) {
    sqlASTNode.orderBy = handleOrderBy((0, _util.unthunk)(fieldConfig.orderBy, sqlASTNode.args || {}, context));
  }

  if (fieldConfig.junction) {
    if (fieldConfig.junction.sortKey) {
      sqlASTNode.junction.sortKey = (0, _util.unthunk)(fieldConfig.junction.sortKey, sqlASTNode.args || {}, context);
    }

    if (fieldConfig.junction.orderBy) {
      sqlASTNode.junction.orderBy = handleOrderBy((0, _util.unthunk)(fieldConfig.junction.orderBy, sqlASTNode.args || {}, context));
    }
  }

  if (!sqlASTNode.sortKey && !sqlASTNode.orderBy) {
    if (sqlASTNode.junction) {
      if (!sqlASTNode.junction.sortKey && !sqlASTNode.junction.orderBy) {
        throw new Error('"sortKey" or "orderBy" required if "sqlPaginate" is true');
      }
    } else {
      throw new Error('"sortKey" or "orderBy" required if "sqlPaginate" is true');
    }
  }

  if (sqlASTNode.sortKey && ((_ref2 = sqlASTNode) != null ? (_ref2 = _ref2.junction) != null ? _ref2.sortKey : _ref2 : _ref2)) {
    throw new Error('"sortKey" must be on junction or main table, not both');
  }

  if (sqlASTNode.orderBy && ((_ref = sqlASTNode) != null ? (_ref = _ref.junction) != null ? _ref.orderBy : _ref : _ref)) {
    throw new Error('"orderBy" must be on junction or main table, not both');
  }
}

function spreadFragments(selections, fragments, typeName) {
  return (0, _lodash.flatMap)(selections, selection => {
    switch (selection.kind) {
      case 'FragmentSpread':
        const fragmentName = selection.name.value;
        const fragment = fragments[fragmentName];
        return spreadFragments(fragment.selectionSet.selections, fragments, typeName);

      case 'InlineFragment':
        if (selection.typeCondition.name.value === typeName) {
          return spreadFragments(selection.selectionSet.selections, fragments, typeName);
        }

        return [];

      default:
        return selection;
    }
  });
}

const validateAndNormalizeDirection = direction => {
  direction = direction.toUpperCase();

  if (direction !== 'ASC' && direction !== 'DESC') {
    throw new Error(direction + ' is not a valid sorting direction');
  }

  return direction;
};

function handleOrderBy(orderBy) {
  if (!orderBy) return undefined;
  const orderings = [];

  if (Array.isArray(orderBy)) {
    for (const ordering of orderBy) {
      (0, _assert.default)(ordering.column, "'column' property must be defined on an ordering in an array");
      orderings.push({
        column: ordering.column,
        direction: validateAndNormalizeDirection(ordering.direction)
      });
    }
  } else if (typeof orderBy === 'object') {
    for (let column in orderBy) {
      orderings.push({
        column,
        direction: validateAndNormalizeDirection(orderBy[column])
      });
    }
  } else if (typeof orderBy === 'string') {
    orderings.push({
      column: orderBy,
      direction: 'ASC'
    });
  } else {
    throw new Error('"orderBy" is invalid type: ' + (0, _util.inspect)(orderBy));
  }

  return orderings;
}