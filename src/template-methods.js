'use strict'

const ts = require('typescript')
const { componentMembers, findDefinition } = require('./resolver')
const { componentOptions, property, initializer } = require('./components')

const globals = new Set(['alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Date',
  'Math', 'JSON', 'console', 'window', 'document', 'globalThis', 'require', 'eval'])

function templateMethod(index, offset, options = {}) {
  if (index.scriptSetup || index.root.parseDiagnostics.length) {
    return null
  }
  const expression = index.templates.find(entry => offset >= entry.start && offset <= entry.end)
  if (!expression) {
    return null
  }
  const tag = index.tags.find(tag => expression.start >= tag.start && expression.end <= tag.end)
  const opening = tag && index.text.slice(tag.start, expression.start)
  if (!opening || !/(?:\s@[\w:-]+(?:\.[\w-]+)*|\sv-on:[\w:-]+(?:\.[\w-]+)*)\s*=\s*["']$/.test(opening)) {
    return null
  }
  const root = expression.index.root
  const block = root.statements[0]
  if (root.parseDiagnostics.length || !block || !ts.isBlock(block) || block.statements.length !== 1 ||
    !ts.isExpressionStatement(block.statements[0])) {
    return null
  }
  let call = block.statements[0].expression
  while (ts.isParenthesizedExpression(call)) {
    call = call.expression
  }
  const handler = ts.isCallExpression(call) ? call.expression : call
  if (!ts.isIdentifier(handler) || handler.text.startsWith('$') || globals.has(handler.text) ||
    expression.locals.has(handler.text)) {
    return null
  }
  const start = expression.start + expression.source.toSource[handler.getStart(root) - expression.prefix]
  const end = expression.start + expression.source.toSource[handler.end - expression.prefix]
  if (offset < start || offset > end || findDefinition(index, offset) ||
    componentMembers(index).some(member => member.name === handler.text) ||
    index.imports.some(binding => binding.local.text === handler.text)) {
    return null
  }
  const component = componentOptions(index)
  // Shared option objects and inherited or dynamically assembled members need more context.
  const parent = component?.parent
  const inline = parent && ts.isExportAssignment(parent)
  if (!inline || component.properties.some(entry => ts.isSpreadAssignment(entry) || !entry.name ||
    ts.isComputedPropertyName(entry.name)) || property(component, 'mixins') || property(component, 'extends') ||
    property(component, 'setup')) {
    return null
  }
  for (const group of ['props', 'computed']) {
    const entry = property(component, group)
    const value = initializer(entry)
    if (entry && (!value || !(ts.isObjectLiteralExpression(value) ||
      group === 'props' && ts.isArrayLiteralExpression(value)) ||
      ts.isObjectLiteralExpression(value) && value.properties.some(member =>
        ts.isSpreadAssignment(member) || !member.name || ts.isComputedPropertyName(member.name)))) {
      return null
    }
  }
  const data = property(component, 'data')
  if (data) {
    const body = data.body || data.initializer?.body
    const returned = body && ts.isBlock(body) ? body.statements.filter(ts.isReturnStatement) : []
    const value = returned.length === 1 ? returned[0].expression : body
    if (!value || !ts.isObjectLiteralExpression(value) ||
      value.properties.some(entry => ts.isSpreadAssignment(entry) || !entry.name || ts.isComputedPropertyName(entry.name))) {
      return null
    }
  }
  const methodsEntry = property(component, 'methods')
  const methods = initializer(methodsEntry)
  if (methodsEntry && (!methods || !ts.isObjectLiteralExpression(methods) ||
    methods.properties.some(entry => ts.isSpreadAssignment(entry) || !entry.name || ts.isComputedPropertyName(entry.name)))) {
    return null
  }
  const args = ts.isCallExpression(call) ? call.arguments : null
  if (args?.some(ts.isSpreadElement)) {
    return null
  }
  const typed = [ts.ScriptKind.TS, ts.ScriptKind.TSX].includes(index.root.scriptKind)
  const names = new Set()
  const parameters = args ? args.map((argument, index) => {
    let name = ts.isIdentifier(argument) && argument.text === '$event' ? 'event' :
      ts.isIdentifier(argument) && !argument.text.startsWith('$') && ts.stringToToken(argument.text) === undefined &&
        !['arguments', 'eval'].includes(argument.text) ? argument.text : `arg${index + 1}`
    const initial = name
    let suffix = 2
    while (names.has(name)) {
      name = initial + suffix++
    }
    names.add(name)
    return name + (typed ? ': unknown' : '')
  }).join(', ') : typed ? '...args: unknown[]' : '...args'
  const nl = index.text.includes('\r\n') ? '\r\n' : '\n'
  const size = Number.isInteger(options.tabSize) && options.tabSize > 0 && options.tabSize <= 8 ? options.tabSize : 2
  const unit = options.insertSpaces === false ? '\t' : ' '.repeat(size)
  function indent(node, fallback) {
    const at = node.getStart(index.root)
    const before = index.text.slice(index.text.lastIndexOf('\n', at - 1) + 1, at)
    return /^[\t ]*$/.test(before) ? before : fallback
  }
  const componentIndent = indent(component, '')
  const optionIndent = methodsEntry ? indent(methodsEntry, componentIndent + unit) : componentIndent + unit
  const methodIndent = methods?.properties.length
    ? indent(methods.properties[0], optionIndent + unit) : optionIndent + unit
  const method = `${handler.text}(${parameters}) {${nl}${methodIndent}}`
  const edits = []
  if (methods) {
    const last = methods.properties.at(-1)
    if (last && !methods.properties.hasTrailingComma) {
      edits.push({ span: { start: last.end, length: 0 }, newText: ',' })
    }
    const close = methods.end - 1
    const line = index.text.lastIndexOf('\n', close - 1) + 1
    const separate = /^[\t ]*$/.test(index.text.slice(line, close))
    edits.push({ span: { start: separate ? line : close, length: 0 },
      newText: `${separate ? '' : nl}${methodIndent}${method}${nl}${separate ? '' : optionIndent}` })
  } else {
    edits.push({ span: { start: component.getStart(index.root) + 1, length: 0 },
      newText: `${nl}${optionIndent}methods: {${nl}${methodIndent}${method}${nl}${optionIndent}},${nl}` })
  }
  return { name: handler.text, span: { start, length: end - start },
    changes: [{ fileName: index.fileName, textChanges: edits }] }
}

module.exports = { templateMethod }
