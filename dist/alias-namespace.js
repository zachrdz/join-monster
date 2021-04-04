"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _generatorics = _interopRequireDefault(require("generatorics"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class AliasNamespace {
  constructor(minify) {
    this.minify = !!minify;
    this.mininym = _generatorics.default.baseNAll('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ#$');
    this.usedTableAliases = new Set();
    this.columnAssignments = {};
  }

  generate(type, name) {
    if (this.minify) {
      if (type === 'table') {
        return this.mininym.next().value.join('');
      }

      if (!this.columnAssignments[name]) {
        this.columnAssignments[name] = this.mininym.next().value.join('');
      }

      return this.columnAssignments[name];
    }

    if (type === 'column') {
      return name;
    }

    name = name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 10);

    while (this.usedTableAliases.has(name)) {
      name += '$';
    }

    this.usedTableAliases.add(name);
    return name;
  }

}

exports.default = AliasNamespace;