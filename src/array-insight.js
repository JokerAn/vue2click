'use strict'

const ts = require('typescript')
const { nodeAt } = require('./insight')

const mutators = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])
const maxRows = 100

function unwrap(expression) {
  while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression))) expression = expression.expression
  return expression
}

function values(index, array) {
  const result = []
  for (const element of array.elements) {
    if (ts.isOmittedExpression(element)) {
      result.push('<空槽>')
    } else if (ts.isStringLiteral(element)) {
      result.push(JSON.stringify(element.text))
    } else if (ts.isNumericLiteral(element)) {
      result.push(element.text)
    } else if (element.kind === ts.SyntaxKind.TrueKeyword || element.kind === ts.SyntaxKind.FalseKeyword ||
      element.kind === ts.SyntaxKind.NullKeyword) {
      result.push(element.getText(index.root))
    } else if (ts.isIdentifier(element) && element.text === 'undefined') {
      result.push('undefined')
    } else if (ts.isPrefixUnaryExpression(element) && element.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(element.operand)) {
      result.push(element.getText(index.root))
    } else {
      return null
    }
  }
  return result
}

function isMutated(index, declaration) {
  if (!declaration || !ts.isIdentifier(declaration.name)) return false
  const name = declaration.name.text
  let mutated = false
  function visit(node) {
    if (mutated) return
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent
      if (ts.isBinaryExpression(parent) && parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        mutated = true
        return
      }
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) {
        const container = parent.parent
        if (ts.isBinaryExpression(container) && container.left === parent ||
          ts.isDeleteExpression(container) && container.expression === parent ||
          ts.isCallExpression(container) && container.expression === parent && ts.isPropertyAccessExpression(parent) &&
            mutators.has(parent.name.text)) {
          mutated = true
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(index.root)
  return mutated
}

function literalIndex(index, offset) {
  let expressionIndex = index
  let localOffset = offset
  const expression = index.templates?.find(item => offset >= item.start && offset < item.end)
  if (expression) {
    expressionIndex = expression.index
    localOffset = expression.source.fromSource[offset - expression.start] + expression.prefix
  }
  let node = nodeAt(expressionIndex, localOffset)
  while (node && !ts.isSourceFile(node)) {
    if (ts.isElementAccessExpression(node)) {
      const argument = unwrap(node.argumentExpression)
      if (ts.isNumericLiteral(argument)) {
        const value = Number(argument.text.replace(/_/g, ''))
        return Number.isSafeInteger(value) && value >= 0 ? value : null
      }
      if (ts.isStringLiteral(argument) && /^(?:0|[1-9]\d*)$/.test(argument.text)) return Number(argument.text)
      return null
    }
    node = node.parent
  }
  return null
}

function callable(index, parameter) {
  const fn = parameter.parent
  let name
  if (ts.isFunctionDeclaration(fn) && fn.parent === index.root) name = fn.name
  if ((ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && ts.isVariableDeclaration(fn.parent) &&
    ts.isVariableStatement(fn.parent.parent?.parent) && fn.parent.parent.parent.parent === index.root) {
    name = fn.parent.name
  }
  return ts.isIdentifier(name) && ts.isIdentifier(parameter.name) ? { fn, name } : null
}

function parameterState(parameter) {
  const state = { assigned: false, elementAccess: false }
  function visit(node) {
    if (!node || ts.isFunctionLike(node)) return
    if (ts.isIdentifier(node) && node.text === parameter.name.text) {
      if (ts.isBinaryExpression(node.parent) && node.parent.left === node &&
        node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) state.assigned = true
      if (ts.isElementAccessExpression(node.parent) && node.parent.expression === node) state.elementAccess = true
    }
    ts.forEachChild(node, visit)
  }
  visit(parameter.parent.body)
  return state
}

async function arrayHoverInfo(index, offset, hit, resolve) {
  const state = { remaining: 64 }
  async function follow(context, expressionOffset, depth, seen) {
    if (!ts.isIdentifier(context.expression) || depth > 6 || --state.remaining < 0) return null
    const next = await resolve(context.hit.document, expressionOffset)
    return next ? inspect(next, depth + 1, seen) : null
  }
  async function fromExpression(context, expression, depth, seen) {
    expression = unwrap(expression)
    if (!expression || depth > 6 || --state.remaining < 0) return null
    if (ts.isArrayLiteralExpression(expression)) return makeArray(context.hit, expression, null)
    if (ts.isIdentifier(expression)) return follow({ ...context, expression }, expression.getStart(context.hit.index.root), depth, seen)
    return null
  }
  async function inferParameter(context, parameter, depth, seen) {
    const target = callable(context.hit.index, parameter)
    const usage = target && parameterState(parameter)
    if (!target || !usage.elementAccess || usage.assigned) return null
    const parameterIndex = target.fn.parameters.indexOf(parameter)
    const calls = []
    function visit(node) {
      if (calls.length > 16) return
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === target.name.text) calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(context.hit.index.root)
    if (!calls.length || calls.length > 16) return null
    let result
    for (const call of calls) {
      if (--state.remaining < 0) return null
      const callee = await resolve(context.hit.document, call.expression.getStart(context.hit.index.root))
      if (!callee || callee.index !== context.hit.index || callee.start !== target.name.getStart(context.hit.index.root)) return null
      const argument = call.arguments[parameterIndex]
      const current = await fromExpression(context, argument, depth + 1, seen)
      if (!current || result && current.id !== result.id) return null
      result = current
    }
    return result
  }
  function makeArray(contextHit, array, declaration) {
    if ((declaration && !ts.isIdentifier(declaration.name)) || isMutated(contextHit.index, declaration)) return null
    const entries = values(contextHit.index, array)
    if (!entries) return null
    const name = declaration?.name?.getText(contextHit.index.root) || 'array'
    return { id: `${contextHit.index.fileName}:${array.getStart(contextHit.index.root)}`, name, entries }
  }
  async function inspect(currentHit, depth, seen) {
    if (!currentHit?.index || !currentHit.document || depth > 6 || --state.remaining < 0) return null
    const key = `${currentHit.index.fileName}:${currentHit.start}`
    if (seen.has(key)) return null
    const nextSeen = new Set([...seen, key])
    const context = { hit: currentHit, expression: nodeAt(currentHit.index, currentHit.start) }
    let node = context.expression
    while (node && !ts.isSourceFile(node)) {
      if (ts.isVariableDeclaration(node)) {
        const expression = unwrap(node.initializer)
        if (ts.isArrayLiteralExpression(expression)) return makeArray(currentHit, expression, node)
        return fromExpression(context, expression, depth, nextSeen)
      }
      if (ts.isParameter(node)) return inferParameter(context, node, depth, nextSeen)
      if (ts.isShorthandPropertyAssignment(node)) {
        return follow(context, node.name.getStart(currentHit.index.root), depth, nextSeen)
      }
      if (ts.isPropertyAssignment(node)) return fromExpression(context, node.initializer, depth, nextSeen)
      node = node.parent
    }
    return null
  }
  const array = hit ? await inspect(hit, 0, new Set()) : null
  if (!array) return null
  const selected = literalIndex(index, offset)
  const rows = selected === null ? array.entries.slice(0, maxRows).map((value, at) => `${at} → ${value}`) :
    [`${selected} → ${array.entries[selected] ?? 'undefined'}`]
  if (selected === null && array.entries.length > maxRows) rows.push(`… 其余 ${array.entries.length - maxRows} 项未显示`)
  if (!rows.length) rows.push('(空数组)')
  return {
    text: selected === null ? array.name : `${array.name}[${selected}]`,
    documentation: `**${selected === null ? '声明时索引映射' : '声明时索引值'}**\n\n\`\`\`text\n${rows.join('\n')}\n\`\`\``
  }
}

module.exports = { arrayHoverInfo }
