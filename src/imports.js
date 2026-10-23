'use strict'

const ts = require('typescript')
const { findImportReference } = require('./resolver')

const modifier = (node, kind) => Boolean(node.modifiers?.some(entry => entry.kind === kind))
const range = (index, node) => ({ fileName: index.fileName, start: node.getStart(index.root), end: node.end })

function declarationName(index, statement, name) {
  if (ts.isVariableStatement(statement)) {
    return index.bindings.find(binding => binding.name === name && binding.scope === index.root &&
      binding.node.getStart(index.root) >= statement.getStart(index.root) && binding.node.end <= statement.end)?.node
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name) {
    return statement.name
  }
  return null
}

async function localDefinition(index, name, context, trail, depth) {
  for (const statement of index.root.statements) {
    const node = declarationName(index, statement, name)
    if (node) {
      return range(index, node)
    }
  }
  const binding = index.imports.find(entry => entry.local.text === name)
  return binding ? importedDefinition(index, binding.specifier, binding.symbol, context, trail, depth + 1) : null
}

// Only follow syntax-declared ES module exports. Every request has its own
// depth/work budget; documents, aliases, and unsaved versions use the same
// request context as Vue component navigation.
async function importedDefinition(from, specifier, symbol, context, trail, depth) {
  if (depth > 24 || --context.remaining < 0 || context.isCancelled?.()) {
    return null
  }
  const fileName = await context.resolveModule(specifier, from.fileName)
  if (!fileName || context.isCancelled?.()) {
    return null
  }
  const marker = JSON.stringify([fileName, symbol])
  if (trail.has(marker)) {
    return null
  }
  const index = await context.loadIndex(fileName)
  if (!index || context.isCancelled?.()) {
    return null
  }
  if (symbol === '*') {
    return { fileName, start: 0, end: 0 }
  }
  const nextTrail = new Set([...trail, marker])
  for (const statement of index.root.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly &&
      statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const entry = statement.exportClause.elements.find(entry => !entry.isTypeOnly && entry.name.text === symbol)
      if (entry) {
        const name = entry.propertyName?.text || entry.name.text
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          return importedDefinition(index, statement.moduleSpecifier.text, name, context, nextTrail, depth + 1)
        }
        return localDefinition(index, name, context, nextTrail, depth + 1)
      }
    }
    if (symbol === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) {
      let value = statement.expression
      while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) {
        value = value.expression
      }
      if (ts.isIdentifier(value)) {
        return localDefinition(index, value.text, context, nextTrail, depth + 1)
      }
      return range(index, value.name || value)
    }
    if (!modifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue
    }
    const isDefault = modifier(statement, ts.SyntaxKind.DefaultKeyword)
    if (symbol === 'default' && isDefault &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) {
      return range(index, statement.name || statement)
    }
    if (symbol !== 'default' && !isDefault) {
      const node = declarationName(index, statement, symbol)
      if (node) {
        return range(index, node)
      }
    }
  }
  if (symbol === 'default') {
    // Vue SFCs expose a default component even without an explicit export.
    return index.scriptSetup ? { fileName, start: 0, end: 0 } : null
  }
  let result = null
  for (const statement of index.root.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || statement.exportClause ||
      !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const hit = await importedDefinition(index, statement.moduleSpecifier.text, symbol, context, nextTrail, depth + 1)
    if (!hit) {
      continue
    }
    if (result && (result.fileName !== hit.fileName || result.start !== hit.start || result.end !== hit.end)) {
      return null
    }
    result = hit
  }
  return result
}

async function findImportedDefinition(index, offset, context) {
  try {
    if (context.isCancelled?.()) {
      return null
    }
    const reference = findImportReference(index, offset)
    if (!reference) {
      return null
    }
    const traversal = { ...context, remaining: 128 }
    const hit = await importedDefinition(index, reference.specifier, reference.symbol, traversal, new Set(), 0)
    return traversal.remaining >= 0 && !context.isCancelled?.() ? hit : null
  } catch {
    return null
  }
}

module.exports = { findImportedDefinition }
