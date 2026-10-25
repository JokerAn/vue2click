'use strict'

const ts = require('typescript')
const { isHTMLTag, isSVGTag, isMathMLTag } = require('@vue/shared')

const camelize = name => name.replace(/-([a-zA-Z0-9])/g, (_, char) => char.toUpperCase())
const pascalize = name => { const camel = camelize(name); return camel[0]?.toUpperCase() + camel.slice(1) }
const key = node => node?.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : null
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) node = node.expression
  return node
}
const property = (node, name) => node && ts.isObjectLiteralExpression(node)
  ? node.properties.find(prop => key(prop) === name) : null
const initializer = prop => prop && (ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer)
const range = (index, node) => ({ fileName: index.fileName, start: node.getStart(index.root), end: node.end })
const exported = node => node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)

function componentAnchor(index, options) {
  const name = property(options, 'name')
  if (name?.name) {
    return range(index, name.name)
  }
  const assignment = index.root.statements.find(statement =>
    ts.isExportAssignment(statement) && !statement.isExportEquals && statement.expression === options)
  return range(index, assignment || options)
}

function topDeclaration(index, name) {
  for (const statement of index.root.statements) {
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(decl => ts.isIdentifier(decl.name) && decl.name.text === name)
      if (declaration) return declaration
    } else if (statement.name?.text === name) return statement
  }
  return null
}

function importBinding(index, name) {
  for (const statement of index.root.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    const specifier = statement.moduleSpecifier.text
    if (clause.name?.text === name) return { specifier, symbol: 'default' }
    const bindings = clause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      const element = bindings.elements.find(element => !element.isTypeOnly && element.name.text === name)
      if (element) return { specifier, symbol: element.propertyName?.text || element.name.text }
    } else if (bindings?.name?.text === name) return { specifier, symbol: '*' }
  }
  return null
}

function localObject(index, expr, seen = new Set()) {
  expr = unwrap(expr)
  if (!expr) return null
  if (ts.isObjectLiteralExpression(expr)) return expr
  if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
    seen.add(expr.text)
    return localObject(index, topDeclaration(index, expr.text)?.initializer, seen)
  }
  if (ts.isCallExpression(expr) && expr.arguments.length && (
    (ts.isIdentifier(expr.expression) && expr.expression.text === 'defineComponent') ||
    (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'extend')
  )) return localObject(index, expr.arguments[0], seen)
  return null
}

function componentOptions(index) {
  const assignment = index.root.statements.find(statement => ts.isExportAssignment(statement) && !statement.isExportEquals)
  return assignment && localObject(index, assignment.expression)
}

function componentRegistration(index, tag) {
  if (isHTMLTag(tag) || isSVGTag(tag) || isMathMLTag(tag) || ['component', 'slot', 'template', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense'].includes(tag.toLowerCase())) return null
  const options = componentOptions(index)
  const registered = localObject(index, initializer(property(options, 'components')))
  for (const name of [...new Set([tag, camelize(tag), pascalize(tag)])]) {
    const prop = property(registered, name)
    if (prop) return initializer(prop)
    if (index.scriptSetup && importBinding(index, name)) return ts.factory.createIdentifier(name)
  }
  return null
}

// Follow only statically known component sources. Never execute project code.
async function resolveComponent(index, expr, context, trail, depth) {
  if (depth > 24 || --context.remaining < 0 || context.isCancelled?.()) return null
  expr = unwrap(expr)
  if (!expr) return null
  if (ts.isObjectLiteralExpression(expr)) return { index, options: expr, node: expr }
  if (ts.isIdentifier(expr)) {
    const binding = importBinding(index, expr.text)
    if (binding && binding.symbol !== '*') return resolveExport(index, binding.specifier, binding.symbol, context, trail, depth + 1)
    const declaration = topDeclaration(index, expr.text)
    const marker = `${index.fileName}:local:${expr.text}`
    if (!declaration?.initializer || trail.has(marker)) return null
    return resolveComponent(index, declaration.initializer, context, new Set([...trail, marker]), depth + 1)
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const binding = importBinding(index, expr.expression.text)
    if (binding?.symbol === '*') return resolveExport(index, binding.specifier, expr.name.text, context, trail, depth + 1)
  }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    const body = expr.body
    if (!ts.isBlock(body)) return resolveComponent(index, body, context, trail, depth + 1)
    const returns = body.statements.filter(ts.isReturnStatement)
    if (returns.length === 1) return resolveComponent(index, returns[0].expression, context, trail, depth + 1)
    return null
  }
  if (!ts.isCallExpression(expr)) return null
  const call = expr.expression
  if ((call.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(call) && call.text === 'require')) &&
    expr.arguments.length === 1 && ts.isStringLiteral(expr.arguments[0])) {
    return resolveExport(index, expr.arguments[0].text, 'default', context, trail, depth + 1)
  }
  if (ts.isIdentifier(call) && call.text === 'defineAsyncComponent') {
    const arg = unwrap(expr.arguments[0])
    const loader = arg && ts.isObjectLiteralExpression(arg) ? initializer(property(arg, 'loader')) : arg
    return resolveComponent(index, loader, context, trail, depth + 1)
  }
  if ((ts.isIdentifier(call) && call.text === 'defineComponent') ||
    (ts.isPropertyAccessExpression(call) && call.name.text === 'extend')) {
    return resolveComponent(index, expr.arguments[0], context, trail, depth + 1)
  }
  return null
}

async function resolveExport(from, specifier, symbol, context, trail, depth) {
  if (depth > 24 || --context.remaining < 0 || context.isCancelled?.()) return null
  const fileName = await context.resolveModule(specifier, from.fileName)
  if (!fileName || context.isCancelled?.()) return null
  const marker = `${fileName}:export:${symbol}`
  if (trail.has(marker)) return null
  const index = await context.loadIndex(fileName)
  if (!index || context.isCancelled?.()) return null
  const nextTrail = new Set([...trail, marker])
  for (const statement of index.root.statements) {
    if (symbol === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return resolveComponent(index, statement.expression, context, nextTrail, depth + 1)
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find(element => !element.isTypeOnly && element.name.text === symbol)
      if (!element) continue
      const original = element.propertyName?.text || element.name.text
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        return resolveExport(index, statement.moduleSpecifier.text, original, context, nextTrail, depth + 1)
      }
      return resolveComponent(index, ts.factory.createIdentifier(original), context, nextTrail, depth + 1)
    }
    if (exported(statement) && ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(decl => ts.isIdentifier(decl.name) && decl.name.text === symbol)
      if (declaration) return resolveComponent(index, declaration.initializer, context, nextTrail, depth + 1)
    }
  }
  // `export *` never forwards default, and conflicting named definitions are
  // ambiguous. Keep the traversal bounded even in circular barrel modules.
  if (symbol !== 'default') {
    let result = null
    for (const statement of index.root.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || statement.exportClause ||
        !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const candidate = await resolveExport(index, statement.moduleSpecifier.text, symbol, context, nextTrail, depth + 1)
      if (!candidate) continue
      if (result && (result.index.fileName !== candidate.index.fileName ||
        result.node?.getStart(result.index.root) !== candidate.node?.getStart(candidate.index.root))) return null
      result = candidate
    }
    if (result) return result
  }
  // A Vue script-setup file exposes its component without an explicit export.
  if (symbol === 'default' && index.scriptSetup) return { index, options: null, node: null }
  return null
}

function propDeclaration(index, options, name) {
  const matches = prop => key(prop) !== null && camelize(key(prop)) === camelize(name)
  function inDeclaration(node) {
    node = unwrap(node)
    if (node && ts.isIdentifier(node)) node = unwrap(topDeclaration(index, node.text)?.initializer)
    if (node && (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node))) {
      return (node.properties || node.members).find(matches)?.name || null
    }
    if (node && ts.isArrayLiteralExpression(node)) return node.elements.find(element => ts.isStringLiteral(element) &&
      camelize(element.text) === camelize(name)) || null
    return null
  }
  const optionsProp = inDeclaration(initializer(property(options, 'props')))
  if (optionsProp) return optionsProp
  if (!index.scriptSetup) return null
  let found = null
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineProps') {
      found = inDeclaration(node.arguments[0]) || found
      let type = node.typeArguments?.[0]
      if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        const declaration = topDeclaration(index, type.typeName.text)
        type = declaration && (ts.isTypeAliasDeclaration(declaration) ? declaration.type : declaration)
      }
      found = inDeclaration(type) || found
    }
    ts.forEachChild(node, visit)
  }
  visit(index.root)
  return found
}

async function findComponentDefinition(index, offset, context) {
  try {
    if (!index || context.isCancelled?.()) return null
    const reference = index.templateReferences?.find(ref => offset >= ref.start && offset < ref.end)
    if (!reference) return null
    const registration = componentRegistration(index, reference.tag)
    if (!registration) return null
    const traversal = { ...context, remaining: 128 }
    const component = await resolveComponent(index, registration, traversal, new Set(), 0)
    if (!component || traversal.remaining < 0 || context.isCancelled?.()) return null
    if (reference.kind === 'event') {
      return null
    }
    if (reference.kind === 'prop' || reference.kind === 'model') {
      let name = reference.name
      if (reference.kind === 'model' && !name) {
        const modelDeclaration = property(component.options, 'model')
        const model = localObject(component.index, initializer(modelDeclaration))
        if (modelDeclaration && !model) return null
        const modelProp = unwrap(initializer(property(model, 'prop')))
        if (modelProp && !ts.isStringLiteral(modelProp)) return null
        name = modelProp?.text || (component.index.scriptSetup ? 'modelValue' : 'value')
        if (!modelProp && !propDeclaration(component.index, component.options, name)) name = 'modelValue'
      }
      const node = propDeclaration(component.index, component.options, name)
      return node ? range(component.index, node) : null
    }
    return component.node ? componentAnchor(component.index, component.options) :
      { fileName: component.index.fileName, start: 0, end: 0 }
  } catch {
    // Missing dependencies, unreadable files and malformed source must not break
    // local definitions or another installed language provider.
    return null
  }
}

async function componentProps(index, tag, context) {
  try {
    const registration = componentRegistration(index, tag)
    if (!registration || context.isCancelled?.()) {
      return []
    }
    const traversal = { ...context, remaining: 128 }
    const component = await resolveComponent(index, registration, traversal, new Set(), 0)
    if (!component || traversal.remaining < 0 || context.isCancelled?.()) {
      return []
    }
    const names = new Set()
    function collect(node) {
      node = unwrap(node)
      if (node && ts.isIdentifier(node)) {
        node = unwrap(topDeclaration(component.index, node.text)?.initializer)
      }
      if (node && (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node))) {
        for (const prop of node.properties || node.members) {
          if (key(prop)) {
            names.add(key(prop))
          }
        }
      } else if (node && ts.isArrayLiteralExpression(node)) {
        for (const entry of node.elements) {
          if (ts.isStringLiteral(entry)) {
            names.add(entry.text)
          }
        }
      }
    }
    collect(initializer(property(component.options, 'props')))
    if (component.index.scriptSetup) {
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineProps') {
          collect(node.arguments[0])
          let type = node.typeArguments?.[0]
          if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
            const declaration = topDeclaration(component.index, type.typeName.text)
            type = declaration && (ts.isTypeAliasDeclaration(declaration) ? declaration.type : declaration)
          }
          collect(type)
        }
        ts.forEachChild(node, visit)
      }
      visit(component.index.root)
    }
    return [...names].filter(name => /^[A-Za-z_$][\w$-]*$/.test(name))
  } catch {
    return []
  }
}

module.exports = {
  findComponentDefinition, componentProps, componentOptions, componentRegistration,
  resolveComponent, property, initializer, localObject, propDeclaration, key
}
