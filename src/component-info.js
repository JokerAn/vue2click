'use strict'

const ts = require('typescript')
const { componentRegistration, resolveComponent, property, initializer, localObject, key } = require('./components')
const { thisOwner } = require('./resolver')
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
const kebab = name => name.replace(/\B([A-Z])/g, '-$1').toLowerCase()

function documentation(node, root) {
  const leading = node ? root.text.slice(node.getFullStart(), node.getStart(root)) : ''
  const docs = node?.jsDoc?.length ? node.jsDoc.map(doc => doc.getText(root)) : leading.match(/\/\*\*[\s\S]*?\*\//g) || []
  return docs.map(doc => doc.replace(/^\/\*\*|\*\/$/g, '')
    .split(/\r?\n/).map(line => line.replace(/^\s*\* ?/, '')).join('\n').trim()).join('\n\n')
}

function literals(type) {
  if (!type) {
    return []
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.flatMap(literals)
  }
  if (ts.isLiteralTypeNode(type)) {
    const value = type.literal
    if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) {
      return [{ value: value.text, text: value.getText(), string: ts.isStringLiteral(value) }]
    }
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) {
      return [{ value: value.getText(), text: value.getText(), string: false }]
    }
  }
  return []
}

function validatorValues(node) {
  if (!node || !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) ||
    node.parameters.length !== 1 || !ts.isIdentifier(node.parameters[0].name)) {
    return []
  }
  let value = ts.isBlock(node.body)
    ? node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0])
      ? node.body.statements[0].expression : undefined
    : node.body
  while (value && ts.isParenthesizedExpression(value)) {
    value = value.expression
  }
  if (!value || !ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== 'includes' || !ts.isArrayLiteralExpression(value.expression.expression) ||
    value.arguments.length !== 1 || !ts.isIdentifier(value.arguments[0]) ||
    value.arguments[0].text !== node.parameters[0].name.text ||
    !value.expression.expression.elements.every(element => ts.isStringLiteral(element) || ts.isNumericLiteral(element) ||
      element.kind === ts.SyntaxKind.TrueKeyword || element.kind === ts.SyntaxKind.FalseKeyword)) {
    return []
  }
  return value.expression.expression.elements.map(element => {
    if (ts.isStringLiteral(element) || ts.isNumericLiteral(element)) {
      return { value: element.text, text: element.getText(), string: ts.isStringLiteral(element) }
    }
    return { value: element.getText(), text: element.getText(), string: false }
  })
}

async function describeComponent(index, options, context) {
  const props = new Map()
  const events = new Map()
  const visited = new Set()
  async function resolveType(declaration, source) {
    if (!declaration || !ts.isTypeReferenceNode(declaration)) {
      return { declaration, source }
    }
    const name = declaration.typeName.getText(source.root)
    let target = source.root.statements.find(node => node.name?.text === name)
    if (target) {
      return { declaration: ts.isTypeAliasDeclaration(target) ? target.type : target, source }
    }
    for (const statement of source.root.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) {
        continue
      }
      const clause = statement.importClause
      const bindings = clause?.namedBindings
      const imported = clause?.name?.text === name || bindings && ts.isNamedImports(bindings) &&
        bindings.elements.some(element => element.name.text === name &&
          (element.isTypeOnly || clause.isTypeOnly))
      if (!imported) {
        continue
      }
      const original = clause.name?.text === name ? 'default' : bindings.elements.find(element =>
        element.name.text === name).propertyName?.text || name
      const file = await context.resolveModule?.(statement.moduleSpecifier.text, source.fileName)
      const targetIndex = file && await context.loadIndex?.(file)
      const exported = targetIndex?.root.statements.find(node => node.name?.text === original &&
        node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      if (exported) {
        return { declaration: ts.isTypeAliasDeclaration(exported) ? exported.type : exported, source: targetIndex }
      }
    }
    return { declaration, source }
  }
  async function addProps(declaration, source) {
    declaration = localObject(source, declaration) || declaration
    const resolved = await resolveType(declaration, source)
    declaration = resolved.declaration
    source = resolved.source
    if (declaration && ts.isTypeAliasDeclaration(declaration)) {
      declaration = declaration.type
    }
    if (declaration && ts.isArrayLiteralExpression(declaration)) {
      for (const entry of declaration.elements.filter(ts.isStringLiteral)) {
        props.set(camel(entry.text), { name: entry.text, type: 'unknown', required: false, values: [] })
      }
    } else if (declaration && (ts.isObjectLiteralExpression(declaration) || ts.isTypeLiteralNode(declaration) || ts.isInterfaceDeclaration(declaration))) {
      for (const entry of declaration.properties || declaration.members) {
        const name = key(entry)
        if (!name) {
          continue
        }
        const runtime = localObject(source, entry.initializer)
        const typeNode = entry.type || initializer(property(runtime, 'type')) || entry.initializer
        const assertion = typeNode && ts.isAsExpression(typeNode) ? typeNode.type : null
        const contract = assertion && ts.isTypeReferenceNode(assertion) && assertion.typeArguments?.[0]
        const rawType = contract?.getText(source.root) || typeNode?.getText(source.root) || 'unknown'
        const runtimeTypes = ts.isArrayLiteralExpression(typeNode)
          ? typeNode.elements.map(value => value.getText(source.root)).map(value =>
            ({ String: 'string', Number: 'number', Boolean: 'boolean', Object: 'object', Array: 'array', Function: 'function' })[value] || value)
          : null
        const type = (runtimeTypes?.join(' | ') || rawType).replace(/\b(String|Number|Boolean|Object|Array|Function)\b/g, word =>
          ({ String: 'string', Number: 'number', Boolean: 'boolean', Object: 'object', Array: 'array', Function: 'function' })[word])
        const defaultNode = property(runtime, 'default')
        const values = [...literals(entry.type || contract), ...validatorValues(initializer(property(runtime, 'validator')))]
        const doc = documentation(entry, source.root)
        // JSDoc literal unions are explicit contracts, unlike arbitrary validator code.
        const union = /@type\s*\{([^}]+)\}/.exec(doc)
        if (union) {
          const parsed = ts.createSourceFile('prop.ts', `type T = ${union[1]}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
          values.push(...literals(parsed.statements[0]?.type))
        }
        props.set(camel(name), {
          name, type: union?.[1] || type,
          required: entry.type ? !entry.questionToken : initializer(property(runtime, 'required'))?.kind === ts.SyntaxKind.TrueKeyword,
          default: defaultNode?.initializer?.getText(source.root) || (defaultNode?.body ? defaultNode.getText(source.root) : undefined),
          documentation: doc, values,
          fileName: source.fileName
        })
      }
    }
  }
  async function collect(source, options) {
    if (context.isCancelled?.() || visited.has(options || source.root)) {
      return
    }
    visited.add(options || source.root)
    const mixins = localObject(source, initializer(property(options, 'mixins'))) || initializer(property(options, 'mixins'))
    const base = initializer(property(options, 'extends'))
    const inherited = [...(base ? [base] : []), ...(mixins && ts.isArrayLiteralExpression(mixins) ? mixins.elements : [])]
    for (const value of inherited) {
      const target = await resolveComponent(source, value, context, new Set(), 0)
      if (target) {
        await collect(target.index, target.options)
      }
    }
    await addProps(initializer(property(options, 'props')), source)
    const emitted = initializer(property(options, 'emits'))
    if (emitted && ts.isArrayLiteralExpression(emitted)) {
      for (const value of emitted.elements.filter(ts.isStringLiteral)) {
        events.set(value.text, { name: value.text, documentation: '', signature: value.text })
      }
    } else if (emitted && ts.isObjectLiteralExpression(emitted)) {
      for (const value of emitted.properties) {
        if (key(value)) {
          const callable = value.parameters ? value : value.initializer
          events.set(key(value), { name: key(value), documentation: documentation(value, source.root),
            signature: `${key(value)}(${callable?.parameters?.map(parameter => parameter.getText(source.root)).join(', ') || ''})` })
        }
      }
    }
    async function visit(node) {
      if (source.scriptSetup && ts.isCallExpression(node) && node.expression.text === 'defineProps') {
        await addProps(node.arguments[0] || node.typeArguments?.[0], source)
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === '$emit' &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && source.options.includes(thisOwner(source, node))) {
        const name = node.arguments[0].text
        if (!events.has(name)) {
          events.set(name, { name, documentation: documentation(node.parent, source.root),
            signature: `${name}(${node.arguments.slice(1).map(value => value.getText(source.root)).join(', ')})` })
        }
      }
      const children = []
      ts.forEachChild(node, child => { children.push(visit(child)) })
      await Promise.all(children)
    }
    await visit(source.root)
    // Read only the template expressions containing an emit, preserving lazy parsing elsewhere.
    for (const expression of source.templates) {
      if (!/\$emit\s*\(/.test(source.text.slice(expression.start, expression.end))) {
        continue
      }
      function emit(node) {
        if (ts.isCallExpression(node) && node.expression.text === '$emit' && !expression.locals.has('$emit') &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && !events.has(node.arguments[0].text)) {
          const name = node.arguments[0].text
          events.set(name, { name, signature: name, documentation: '' })
        }
        ts.forEachChild(node, emit)
      }
      emit(expression.index.root)
    }
  }
  await collect(index, options)
  return { props: [...props.values()], events: [...events.values()] }
}

async function componentInfo(index, tag, context) {
  const registration = componentRegistration(index, tag)
  if (!registration || context.isCancelled?.()) {
    return null
  }
  const traversal = { ...context, remaining: 128 }
  const resolved = await resolveComponent(index, registration, traversal, new Set(), 0)
  return resolved ? describeComponent(resolved.index, resolved.options, traversal) : null
}

function propDetail(prop) {
  return `${prop.name}: ${prop.type}${prop.required ? ' (required)' : ''}${prop.default !== undefined ? ` = ${prop.default}` : ''}`
}

module.exports = { componentInfo, describeComponent, documentation, propDetail, camel, kebab }
