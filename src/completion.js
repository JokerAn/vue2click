'use strict'

const ts = require('typescript')
const { componentMembers, instanceCompletions, templateThisAt } = require('./resolver')
const snippets = require('../snippets/vue.json')

const identifier = /[$\u200c\u200d\p{ID_Continue}]/u

function wordRange(text, offset, attribute = false) {
  const character = attribute ? /[\w$-]/ : identifier
  let start = offset
  let end = offset
  while (start > 0 && character.test(text[start - 1])) {
    start--
  }
  while (end < text.length && character.test(text[end])) {
    end++
  }
  return { start, end }
}

function inCommentOrString(root, offset) {
  // Descend through parsed tokens so regexes and template strings are never
  // reinterpreted by a context-free scanner as division or comment markers.
  let token = root
  while (true) {
    const child = token.getChildren(root).find(node => offset >= node.getFullStart() &&
      (offset < node.end || (node.kind === ts.SyntaxKind.EndOfFileToken && offset <= node.end)))
    if (!child) {
      break
    }
    token = child
  }
  const start = token.getStart(root)
  if (offset >= start && token.kind !== ts.SyntaxKind.EndOfFileToken) {
    return ts.isStringLiteralLike(token) || ts.isRegularExpressionLiteral(token) ||
      token.kind === ts.SyntaxKind.TemplateHead || token.kind === ts.SyntaxKind.TemplateMiddle ||
      token.kind === ts.SyntaxKind.TemplateTail
  }
  // A token's leading trivia contains only whitespace/comments. It is safe to
  // scan this short gap without ever crossing a preceding regex literal.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false)
  scanner.setText(root.text, token.getFullStart(), start - token.getFullStart())
  while (scanner.getTokenEnd() <= offset) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken) {
      break
    }
    if (offset > scanner.getTokenStart() && offset <= scanner.getTokenEnd()) {
      return kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia
    }
  }
  return false
}

function isExpressionPosition(root, range) {
  let id
  function visit(node) {
    if (range.start < node.getStart(root) || range.end > node.end) {
      return
    }
    if (ts.isIdentifier(node)) {
      id = node
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  if (!id) {
    return true // Empty operands such as `return |` and `{{ | }}`.
  }
  const parent = id.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    return false
  }
  // Shorthand properties read a value; named keys and declaration bindings do
  // not. A colon in a conditional expression is deliberately not involved.
  return !(parent.name === id && (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
    ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)))
}

function snippetItems(context, range) {
  return Object.values(snippets).filter(snippet => snippet.context === context).flatMap(snippet => {
    const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix]
    return prefixes.map(name => ({
      name, kind: 'snippet', detail: snippet.description,
      insertText: Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body, ...range
    }))
  })
}

function registeredComponents(index) {
  const component = index.options[0]
  const options = component?.properties.find(prop => prop.name?.text === 'components')?.initializer
  const result = new Set()
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const prop of options.properties) {
      if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        result.add(prop.name.text)
      }
    }
  }
  if (index.scriptSetup) {
    for (const node of index.root.statements) {
      if (ts.isImportDeclaration(node) && node.importClause?.name &&
        !node.importClause.isTypeOnly && /\.vue$/.test(node.moduleSpecifier.text)) {
        result.add(node.importClause.name.text)
      }
    }
  }
  return [...result].filter(name => /^[A-Za-z][\w.-]*$/.test(name))
    .map(name => ({ name, kind: 'class', detail: 'Vue component' }))
}

function expressionItems(index, expression, offset) {
  const local = expression.source.fromSource[offset - expression.start] + expression.prefix
  if (inCommentOrString(expression.index.root, local)) {
    return []
  }
  const text = expression.index.source
  const range = wordRange(text, local)
  const before = text.slice(expression.prefix, range.start)
  let members
  if (/\?\.$|\.$/.test(before)) {
    members = templateThisAt(expression.index, local)
      ? componentMembers(index) : []
  } else {
    if (!isExpressionPosition(expression.index.root, range)) {
      return []
    }
    const locals = new Set(expression.locals)
    for (const binding of expression.index.bindings) {
      if (local >= binding.scope.getStart(expression.index.root) && local <= binding.scope.end) {
        locals.add(binding.name)
      }
    }
    members = [...componentMembers(index).filter(item => !locals.has(item.name)),
      ...[...locals].map(name => ({ name, kind: 'variable', detail: 'Vue template local' }))]
  }
  return members
}

function completionContext(index, text, offset, settings = {}) {
  const range = wordRange(text, offset)
  const block = index.blocks.find(block => offset >= block.start && offset <= block.end)
  if (!block) {
    const rest = text.slice(0, range.start) + text.slice(range.end)
    return { items: settings.snippets !== false && !rest.trim() ? snippetItems('root', range) : [] }
  }
  if (block.external) {
    return { items: [] }
  }
  if (block.tag === 'script') {
    if ((block.lang && !['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript'].includes(block.lang)) ||
      inCommentOrString(index.root, offset)) {
      return { items: [] }
    }
    const items = settings.members !== false ? instanceCompletions(index, offset).map(item => ({ ...item, ...range })) : []
    const line = text.slice(text.lastIndexOf('\n', range.start - 1) + 1, range.start)
    if (settings.snippets !== false && /^\s*$/.test(line)) {
      items.push(...snippetItems('script', range))
    }
    return { items }
  }
  if (block.tag !== 'template' || (block.lang && block.lang !== 'html')) {
    return { items: [] }
  }
  const expression = index.templates.find(exp => offset >= exp.start && offset <= exp.end)
  if (expression) {
    return { items: settings.members !== false
      ? expressionItems(index, expression, offset).map(item => ({ ...item, ...range })) : [] }
  }
  const tag = index.tags.find(tag => offset > tag.start && offset < tag.end)
  if (!tag) {
    const textNode = index.templateTexts.find(node => offset >= node.start && offset <= node.end)
    if (settings.members !== false && textNode && /<[A-Za-z\d_.-]*$/.test(text.slice(textNode.start, offset))) {
      return { items: registeredComponents(index).map(item => ({ ...item, ...range })) }
    }
    return { items: [] }
  }
  const attributeRange = wordRange(text, offset, true)
  const before = text.slice(tag.start, attributeRange.start)
  if (/^<[A-Za-z\d_.-]*$/.test(before)) {
    return { items: settings.members !== false
      ? registeredComponents(index).map(item => ({ ...item, ...attributeRange })) : [] }
  }
  // Never inject snippets into static values, comments or already completed attributes.
  const attribute = tag.attributes.find(attr => offset > attr.start && offset <= attr.end)
  if (attribute && /[='"]/.test(text.slice(attribute.start, offset))) {
    return { items: [] }
  }
  if (!/\s$|[:@]$/.test(before)) {
    return { items: [] }
  }
  const items = settings.snippets !== false && /\s$/.test(before) ? snippetItems('attribute', attributeRange) : []
  const used = new Set(tag.attributes.filter(attr => attr !== attribute).map(attr => attr.name))
  return { items, props: settings.members !== false && !tag.dynamic && !/@$/.test(before)
    ? { tag: tag.tag, used, ...attributeRange } : undefined }
}

module.exports = { completionContext }
