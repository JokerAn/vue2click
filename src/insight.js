'use strict'

const ts = require('typescript')

function nodeAt(index, offset) {
  let found
  function visit(node) {
    if (offset < node.getStart(index.root) || offset >= node.end) {
      return
    }
    found = node
    ts.forEachChild(node, visit)
  }
  visit(index.root)
  return found
}

function declarationInfo(index, offset) {
  let node = nodeAt(index, offset)
  while (node && !ts.isSourceFile(node)) {
    const docs = [...(node.jsDoc || [])]
    const callable = ts.isFunctionLike(node) ? node :
      node.initializer && ts.isFunctionLike(node.initializer) ? node.initializer : undefined
    if (ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent?.parent)) {
      docs.push(...(node.parent.parent.jsDoc || []))
    }
    if (docs.length || callable) {
      const name = node.name?.getText(index.root) || callable?.name?.getText(index.root) || ''
      return {
        text: callable ? `${name}(${callable.parameters.map(parameter => parameter.getText(index.root)).join(', ')})` : name,
        documentation: docs.map(doc => doc.getText(index.root)
          .replace(/^\/\*\*|\*\/$/g, '').split(/\r?\n/)
          .map(line => line.replace(/^\s*\* ?/, '')).join('\n').trim()).join('\n\n'),
        span: { start: node.name?.getStart(index.root) ?? node.getStart(index.root),
          length: (node.name?.end ?? node.end) - (node.name?.getStart(index.root) ?? node.getStart(index.root)) }
      }
    }
    node = node.parent
  }
  return null
}

function documentSymbols(index) {
  const result = []
  function symbol(node, name, kind, children = []) {
    const start = node.getStart(index.root)
    const selection = node.name || node
    return {
      name, kind, start, end: node.end,
      selectionStart: selection.getStart(index.root), selectionEnd: selection.end, children
    }
  }
  function childrenOf(node) {
    const value = node.initializer || node
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.filter(prop => prop.name).map(prop =>
        symbol(prop, prop.name.getText(index.root), ts.isMethodDeclaration(prop) || ts.isFunctionLike(prop.initializer) ? 'Method' : 'Property'))
    }
    const body = node.body || value.body
    const returned = body && ts.isBlock(body) ? body.statements.find(statement =>
      ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression))?.expression : body
    return returned && ts.isObjectLiteralExpression(returned) ? childrenOf({ initializer: returned }) : []
  }
  for (const options of index.options) {
    for (const property of options.properties) {
      if (property.name) {
        result.push(symbol(property, property.name.getText(index.root),
          ts.isMethodDeclaration(property) ? 'Method' : 'Object', childrenOf(property)))
      }
    }
  }
  for (const statement of index.root.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      result.push(symbol(statement, statement.name?.text || 'default', ts.isClassDeclaration(statement) ? 'Class' : 'Function'))
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        result.push(symbol(declaration, declaration.name.getText(index.root), 'Variable', childrenOf(declaration)))
      }
    }
  }
  return result
}

module.exports = { nodeAt, declarationInfo, documentSymbols }
