'use strict'

const ts = require('typescript')
const { property, initializer } = require('./components')

function scanGlobalRegistrations(index) {
  const result = { components: [], members: [], stores: [] }
  const declarations = new Map()
  for (const statement of index.root.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration)
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement)
    }
  }
  function resolve(expression, seen = new Set()) {
    if (!expression) return null
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) return resolve(expression.expression, seen)
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return null
      const declaration = declarations.get(expression.text)
      return declaration && (ts.isFunctionDeclaration(declaration) ? declaration :
        resolve(declaration.initializer, new Set([...seen, expression.text])))
    }
    return expression
  }
  const exported = index.root.statements.find(statement => ts.isExportAssignment(statement) && !statement.isExportEquals)
  const plugin = resolve(exported?.expression)
  const installers = new Set()
  const install = plugin && ts.isObjectLiteralExpression(plugin) ? property(plugin, 'install') : null
  const callable = install && (ts.isMethodDeclaration(install) ? install : resolve(initializer(install)))
  if (callable && ts.isFunctionLike(callable)) installers.add(callable)
  // Only module-level assignments to the exported plugin object are install hooks.
  for (const statement of index.root.statements) {
    const expression = ts.isExpressionStatement(statement) && statement.expression
    if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expression.left) && expression.left.name.text === 'install' &&
      plugin && resolve(expression.left.expression) === plugin) {
      const value = resolve(expression.right)
      if (value && ts.isFunctionLike(value)) installers.add(value)
    }
  }
  function binding(identifier) {
    for (let scope = identifier.parent; scope; scope = scope.parent) {
      const declaration = index.bindings.find(value => value.name === identifier.text && value.scope === scope)
      if (declaration) return declaration.node
    }
    return null
  }
  const imports = index.imports
  function imported(identifier, source, symbols) {
    return ts.isIdentifier(identifier) && !binding(identifier) &&
      imports.some(value => value.local.text === identifier.text && value.specifier === source && symbols.includes(value.symbol))
  }
  function isVue(identifier, parameter) {
    if (!ts.isIdentifier(identifier)) return false
    const local = binding(identifier)
    return parameter && local === parameter || !local && imported(identifier, 'vue', ['default', '*'])
  }
  function visit(node, parameter = null) {
    if (ts.isFunctionLike(node)) {
      if (!installers.has(node)) return
      const first = node.parameters[0]
      if (first && ts.isIdentifier(first.name) && node.body) visit(node.body, first.name)
      return
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'component' && isVue(node.expression.expression, parameter) &&
      node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0])) {
      result.components.push({ name: node.arguments[0].text, index, expression: node.arguments[1] })
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && ts.isPropertyAccessExpression(node.left.expression) &&
      node.left.expression.name.text === 'prototype' && isVue(node.left.expression.expression, parameter)) {
      result.members.push({ name: node.left.name.text, index, node: node.left.name })
    }
    if (ts.isNewExpression(node) && node.arguments?.[0]) {
      const ctor = node.expression
      if (ts.isPropertyAccessExpression(ctor) && ctor.name.text === 'Store' &&
        imported(ctor.expression, 'vuex', ['default', '*']) ||
        ts.isIdentifier(ctor) && imported(ctor, 'vuex', ['Store'])) {
        result.stores.push({ index, expression: node.arguments[0] })
      }
    }
    ts.forEachChild(node, child => visit(child, parameter))
  }
  visit(index.root)
  return result
}

function createGlobalRegistry(files, load) {
  let contributions = new Map()
  let cached
  let revision = 0
  let pending
  const dirty = new Set()
  async function get() {
    if (cached) return cached
    if (pending?.revision === revision) return pending.promise
    const version = revision
    const promise = (async () => {
      const currentFiles = new Set(files())
      const next = new Map()
      for (const file of currentFiles) {
        if (contributions.has(file) && !dirty.has(file)) {
          next.set(file, contributions.get(file))
          continue
        }
        const index = await load(file, true)
        const value = index ? scanGlobalRegistrations(index) : null
        next.set(file, value && (value.components.length || value.members.length || value.stores.length) ? value : null)
      }
      if (version !== revision) return get()
      const result = { components: [], members: [], stores: [] }
      for (const value of next.values()) {
        if (!value) continue
        for (const kind of Object.keys(result)) result[kind].push(...value[kind])
      }
      contributions = next
      dirty.clear()
      cached = result
      return result
    })()
    pending = { revision: version, promise }
    try {
      return await promise
    } finally {
      if (pending?.promise === promise) pending = null
    }
  }
  return {
    get,
    invalidate(file) {
      dirty.add(file)
      cached = null
      revision++
    },
    dispose() {
      contributions.clear()
      dirty.clear()
      cached = null
      revision++
    }
  }
}

module.exports = { scanGlobalRegistrations, createGlobalRegistry }
