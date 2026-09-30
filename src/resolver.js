'use strict'

const ts = require('typescript')

// Keep every offset/line unchanged so the resulting Location points into the real .vue file.
function sourceText(text, language) {
  if (language !== 'vue') return text
  const chars = text.split('')
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  const keep = []
  for (const match of text.matchAll(scripts)) {
    if (/\bsrc\s*=/.test(match[1])) continue
    const from = match.index + match[0].indexOf('>') + 1
    keep.push([from, from + match[2].length])
  }
  if (!keep.length) return text.replace(/[^\r\n]/g, ' ')
  let at = 0
  for (const [from, end] of keep) {
    while (at < from) { if (chars[at] !== '\r' && chars[at] !== '\n') chars[at] = ' '; at++ }
    at = end
  }
  while (at < chars.length) { if (chars[at] !== '\r' && chars[at] !== '\n') chars[at] = ' '; at++ }
  return chars.join('')
}

function buildIndex(text, language, fileName = 'untitled.js') {
  const source = sourceText(text, language)
  const kind = /typescript/.test(language) || (language === 'vue' && /<script\b[^>]*\blang\s*=\s*["'](?:ts|tsx)["']/i.test(text))
    ? ts.ScriptKind.TS : /react/.test(language) ? ts.ScriptKind.JSX : ts.ScriptKind.JS
  const root = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const bindings = []
  const options = []
  const thisAssignments = []
  const pushBinding = (name, scope) => {
    if (ts.isIdentifier(name)) bindings.push({ name: name.text, node: name, scope })
    else if (name && (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))) {
      for (const element of name.elements) if (ts.isBindingElement(element)) pushBinding(element.name, scope)
    }
  }
  function visit(node) {
    if (ts.isExportAssignment(node)) {
      const obj = asObject(node.expression)
      if (obj) options.push(obj)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      thisAssignments.push(node.left.name)
    }
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent
      const blockScoped = (list.flags & ts.NodeFlags.BlockScoped) !== 0
      pushBinding(node.name, enclosingScope(node, !blockScoped))
    } else if (ts.isParameter(node)) pushBinding(node.name, enclosingFunction(node))
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (node.name) pushBinding(node.name, enclosingScope(node))
    } else if (ts.isFunctionExpression(node) && node.name) pushBinding(node.name, node)
    else if (ts.isCatchClause(node) && node.variableDeclaration) pushBinding(node.variableDeclaration.name, node.block)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return { root, source, bindings, options, thisAssignments }
}

function asObject(expr) {
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression
  if (ts.isObjectLiteralExpression(expr)) return expr
  if (ts.isCallExpression(expr) && expr.arguments.length) return asObject(expr.arguments[0])
  return null
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current
  }
}

function enclosingScope(node, varScope = false) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current) || (!varScope && (
      ts.isBlock(current) || ts.isCaseBlock(current) || ts.isForStatement(current) ||
      ts.isForOfStatement(current) || ts.isForInStatement(current)
    ))) return current
  }
}

function propName(prop) {
  if (prop && prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name))) return prop.name.text
  return null
}

function member(obj, name) {
  return obj.properties.find(p => propName(p) === name)
}

function nameNode(prop) {
  return prop && prop.name && prop.name.getStart ? prop.name : null
}

function vueMember(obj, name) {
  for (const group of ['methods', 'computed', 'props']) {
    const container = member(obj, group)
    if (container && ts.isObjectLiteralExpression(container.initializer)) {
      const found = nameNode(member(container.initializer, name))
      if (found) return found
    }
  }
  for (const group of ['data', 'setup']) {
    const method = member(obj, group)
    const body = method && (method.body || method.initializer?.body)
    if (!body) continue
    let result = null
    function search(node) {
      if (ts.isReturnStatement(node) && node.expression) {
        result = asObject(node.expression) || result
        return
      }
      if (node !== body && ts.isFunctionLike(node)) return
      ts.forEachChild(node, search)
    }
    search(body)
    if (result) {
      const found = nameNode(member(result, name))
      if (found) return found
    }
  }
  const direct = nameNode(member(obj, name))
  return direct && !['methods', 'computed', 'data', 'props', 'watch', 'setup'].includes(name) ? direct : null
}

function objectOwner(index, obj) {
  if (index.options.includes(obj)) return obj
  const property = obj.parent
  if (ts.isPropertyAssignment(property) &&
    ['methods', 'computed', 'watch'].includes(propName(property)) &&
    index.options.includes(property.parent)) return property.parent
  return obj
}

// In watch: { field: { handler: function () {} } }, the handler's this is
// the Vue instance, but other methods on nested objects keep their own this.
function watchHandlerOwner(index, fn) {
  let entry = null
  if (ts.isMethodDeclaration(fn) && propName(fn) === 'handler' && ts.isObjectLiteralExpression(fn.parent)) {
    entry = fn.parent
  } else if (ts.isFunctionExpression(fn) && ts.isPropertyAssignment(fn.parent) &&
    propName(fn.parent) === 'handler' && ts.isObjectLiteralExpression(fn.parent.parent)) {
    entry = fn.parent.parent
  }
  if (!entry || !ts.isPropertyAssignment(entry.parent) || entry.parent.initializer !== entry ||
    !ts.isObjectLiteralExpression(entry.parent.parent)) return null
  const watch = entry.parent.parent
  const property = watch.parent
  if (ts.isPropertyAssignment(property) && propName(property) === 'watch' &&
    index.options.includes(property.parent)) return property.parent
  return null
}

function thisOwner(index, node) {
  for (let current = node.parent; current; current = current.parent) {
    // Arrow functions inherit this. Other functions and methods create their own binding.
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) {
      const watchOwner = watchHandlerOwner(index, current)
      if (watchOwner) return watchOwner
      const container = current.parent
      if (ts.isClassLike(container)) return container
      if (ts.isObjectLiteralExpression(container)) return objectOwner(index, container)
      if (ts.isPropertyAssignment(container) && ts.isObjectLiteralExpression(container.parent)) {
        return objectOwner(index, container.parent)
      }
      return current
    }
    if (ts.isClassLike(current)) return current // Arrow-function class fields.
  }
  return index.root
}

function memberOfThis(index, identifier) {
  const owner = thisOwner(index, identifier)
  const name = identifier.text
  let declaration = null
  if (ts.isClassLike(owner)) {
    declaration = nameNode(owner.members.find(m => propName(m) === name))
  } else if (ts.isObjectLiteralExpression(owner)) {
    declaration = index.options.includes(owner)
      ? vueMember(owner, name)
      : nameNode(member(owner, name))
  }
  if (declaration) return declaration

  // Dynamic instance fields may be first declared with this.foo = value.
  // Do not reuse assignments made on another class, object or function's this.
  return index.thisAssignments.find(n => n.text === name &&
    n.getStart(index.root) < identifier.getStart(index.root) &&
    thisOwner(index, n) === owner) || null
}

function findIdentifier(root, offset) {
  let found = null
  function walk(node) {
    if (offset < node.getStart(root) || offset >= node.end) return
    if (ts.isIdentifier(node) && offset >= node.getStart(root) && offset < node.end) found = node
    ts.forEachChild(node, walk)
  }
  walk(root)
  return found
}

function findDefinition(index, offset) {
  if (!index || offset < 0 || offset >= index.source.length || index.source[offset] === ' ') return null
  const id = findIdentifier(index.root, offset)
  if (!id) return null
  const parent = id.parent
  let target
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    if (parent.expression.kind !== ts.SyntaxKind.ThisKeyword) return null
    target = memberOfThis(index, id)
  } else if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === id) {
    return null // Do not turn object keys into unqualified variables.
  } else {
    const candidates = index.bindings.filter(b => b.name === id.text && isAncestor(b.scope, id))
    candidates.sort((a, b) => depth(b.scope) - depth(a.scope) ||
      (a.node.getStart(index.root) <= offset ? -1 : 1) - (b.node.getStart(index.root) <= offset ? -1 : 1))
    target = candidates[0]?.node
  }
  if (!target) return null
  return { start: target.getStart(index.root), end: target.end }
}

function isAncestor(ancestor, node) {
  for (let current = node; current; current = current.parent) if (current === ancestor) return true
  return false
}
function depth(node) { let d = 0; for (; node; node = node.parent) d++; return d }

module.exports = { buildIndex, findDefinition, sourceText }
