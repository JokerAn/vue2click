'use strict'

const ts = require('typescript')
const { componentOptions, property, initializer } = require('./components')
const { componentMembers } = require('./resolver')

// Names the browser provides to a template expression. Anything else must be
// declared on the component or it is undefined at runtime.
const globals = new Set(['alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'Number', 'String', 'Boolean', 'Object', 'Array', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Symbol', 'Error', 'Math', 'JSON', 'console', 'window', 'document', 'globalThis', 'require', 'eval',
  'undefined', 'NaN', 'Infinity', 'arguments'])

function unwrap(node) {
  while (node && ts.isParenthesizedExpression(node)) {
    node = node.expression
  }
  return node
}

// Member analysis is only trustworthy when nothing can add members at runtime.
function plainObject(node) {
  return Boolean(node) && ts.isObjectLiteralExpression(node) && !node.properties.some(entry =>
    ts.isSpreadAssignment(entry) || !entry.name || ts.isComputedPropertyName(entry.name))
}

function staticComponent(index) {
  if (index.scriptSetup || index.root.parseDiagnostics.length || (index.options || []).length > 1) {
    return null
  }
  const component = componentOptions(index)
  if (!component || !component.parent || !ts.isExportAssignment(component.parent)) {
    return null
  }
  if (component.properties.some(entry =>
    ts.isSpreadAssignment(entry) || !entry.name || ts.isComputedPropertyName(entry.name))) {
    return null
  }
  for (const key of ['mixins', 'extends', 'setup']) {
    if (property(component, key)) {
      return null
    }
  }
  const props = property(component, 'props')
  if (props) {
    const value = unwrap(initializer(props))
    if (ts.isArrayLiteralExpression(value)) {
      if (value.elements.some(entry => !ts.isStringLiteral(entry))) return null
    } else if (!plainObject(value)) {
      return null
    }
  }
  for (const key of ['computed', 'methods', 'filters', 'components']) {
    const entry = property(component, key)
    if (entry && !plainObject(unwrap(initializer(entry)))) return null
  }
  const data = property(component, 'data')
  if (data) {
    const body = data.body || data.initializer?.body
    const returned = body && ts.isBlock(body) ? body.statements.filter(ts.isReturnStatement) : []
    const value = body && ts.isBlock(body) ? (returned.length === 1 ? returned[0].expression : null) : body
    if (!plainObject(unwrap(value))) return null
  }
  return component
}

function isReference(node) {
  const parent = node.parent
  if (!parent) return false
  // `foo.bar` reports `foo`; the member name belongs to the receiver.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  // `{ key: value }` reports `value` only.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isShorthandPropertyAssignment(parent)) return true
  // A single unparenthesised arrow parameter is the identifier itself.
  if (ts.isFunctionLike(parent)) {
    return parent.name !== node && !(parent.parameters || []).includes(node)
  }
  if (ts.isMethodDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) {
    return parent.name !== node
  }
  if (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) ||
    ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isPropertySignature(parent) ||
    ts.isTypeParameterDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isLabeledStatement(parent)) {
    return false
  }
  // Vue 2 filters read as `value | filter`; the right side is a filter name.
  if (ts.isBinaryExpression(parent) && parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.BarToken) {
    return false
  }
  return true
}

function spanOf(expression, node) {
  const root = expression.index.root
  const source = expression.source
  const start = source.toSource[node.getStart(root) - expression.prefix]
  const end = source.toSource[node.end - expression.prefix]
  return start === undefined || end === undefined ? null : { start: expression.start + start, end: expression.start + end }
}

// Inline handlers may declare their own parameters and variables, for example
// `@click="e => submit(e)"`. Those names shadow nothing on the component.
function declaredNames(root) {
  const names = new Set()
  function collect(name) {
    if (ts.isIdentifier(name)) {
      names.add(name.text)
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) collect(element.name)
      }
    }
  }
  function visit(node) {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
      collect(node.name)
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collect(node.variableDeclaration.name)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return names
}

// Walks every identifier a template can actually read: attribute values and
// interpolations, minus directive arguments, template locals and inline locals.
function forEachReference(index, visit) {
  for (const expression of index.templates) {
    // Directive arguments (`@click`, `:value`) carry attribute names, not values.
    if (expression.argument) continue
    const root = expression.index.root
    const declared = declaredNames(root)
    const seen = new Set()
    function walk(node) {
      if (ts.isIdentifier(node) && isReference(node) && !expression.locals.has(node.text) &&
        !declared.has(node.text)) {
        const value = spanOf(expression, node)
        // A kebab-case attribute name parses as subtraction; it is not a member.
        const split = value && (index.text[value.start - 1] === '-' || index.text[value.end] === '-')
        const key = value && `${value.start}:${value.end}`
        if (value && !split && !seen.has(key)) {
          seen.add(key)
          visit({ node, name: node.text, value })
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(root)
  }
}

function membersOf(index, component) {
  const known = new Set(componentMembers(index).map(member => member.name))
  for (const binding of index.imports || []) {
    if (binding.local?.text) known.add(binding.local.text)
  }
  const registered = unwrap(initializer(property(component, 'components')))
  if (registered && ts.isObjectLiteralExpression(registered)) {
    for (const entry of registered.properties) {
      if (entry.name) known.add(entry.name.getText(index.root))
    }
  }
  return known
}

// Reports template identifiers that no component member can satisfy. The
// function refuses to guess: dynamic member sources, shared option objects and
// broken syntax produce no diagnostics at all.
function templateDiagnostics(index) {
  const component = staticComponent(index)
  if (!component || !index.templates.length) return []
  const known = membersOf(index, component)
  const result = []
  forEachReference(index, ({ name, value }) => {
    if (known.has(name) || globals.has(name) || /^[$_]/.test(name)) return
    result.push({ ...value, name, message: `模板中的 “${name}” 未在组件中声明` })
  })
  return result
}

// Spans of one member name inside this document's template. Used by rename so a
// component member keeps its template call sites.
function templateReferences(index, name) {
  const result = []
  forEachReference(index, ({ name: value, value: span }) => {
    if (value === name) result.push(span)
  })
  return result
}

module.exports = { templateDiagnostics, templateReferences, staticComponent, globals }
