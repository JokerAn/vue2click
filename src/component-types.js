'use strict'

const ts = require('typescript')

// Resolve only explicit syntax. This intentionally does not create a project checker.
function createTypeResolver(context) {
  let remaining = 256
  const modules = new Map()
  const ambiguous = {}
  const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const defaulted = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  const typeDeclaration = node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
  const active = (depth) => depth <= 24 && --remaining >= 0 && !context.isCancelled?.()
  const memberName = node => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text : null

  function unambiguous(entries) {
    const groups = new Map()
    for (const entry of entries) {
      const name = memberName(entry.node)
      const group = groups.get(name) || []
      group.push(entry)
      groups.set(name, group)
    }
    return [...groups.values()].map(group => {
      const first = group[0]
      const conflict = group.some(entry => entry.ambiguous || entry.source.fileName !== first.source.fileName ||
        entry.node.pos !== first.node.pos || entry.node.end !== first.node.end)
      // Keep the conflict through nested intersections so an outer branch cannot restore it.
      return conflict ? { ...first, ambiguous: true } : first
    })
  }

  async function moduleIndex(source, specifier) {
    if (context.isCancelled?.()) {
      return null
    }
    const marker = `${source.fileName}:${specifier}`
    if (!modules.has(marker)) {
      modules.set(marker, (async () => {
        try {
          const file = await context.resolveModule?.(specifier, source.fileName)
          if (!file || context.isCancelled?.()) {
            return null
          }
          const index = await context.loadIndex?.(file)
          return context.isCancelled?.() ? null : index
        } catch {
          return null
        }
      })())
    }
    return modules.get(marker)
  }

  async function findExport(source, name, trail, depth) {
    const marker = `${source.fileName}:export:${name}`
    if (!active(depth) || trail.has(marker)) {
      return null
    }
    const next = new Set([...trail, marker])
    const direct = []
    for (const statement of source.root.statements) {
      if (typeDeclaration(statement) && exported(statement) &&
        (defaulted(statement) ? name === 'default' : statement.name?.text === name)) {
        direct.push({ declaration: statement, source })
      }
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue
      }
      for (const element of statement.exportClause.elements.filter(element => element.name.text === name)) {
        const original = element.propertyName?.text || element.name.text
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? await moduleIndex(source, statement.moduleSpecifier.text) : null
        direct.push(statement.moduleSpecifier
          ? target && await findExport(target, original, next, depth + 1)
          : await findLocal(source, original, next, depth + 1))
      }
    }
    if (direct.length) {
      return direct.length === 1 ? direct[0] : ambiguous
    }
    if (name === 'default') {
      return null
    }
    let result = null
    for (const statement of source.root.statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause ||
        !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue
      }
      const target = await moduleIndex(source, statement.moduleSpecifier.text)
      const candidate = target && await findExport(target, name, next, depth + 1)
      if (!candidate) {
        continue
      }
      if (candidate === ambiguous || result && (result.source.fileName !== candidate.source.fileName ||
        result.declaration.pos !== candidate.declaration.pos || result.declaration.end !== candidate.declaration.end)) {
        return ambiguous
      }
      result = candidate
    }
    return result
  }

  async function findLocal(source, name, trail, depth) {
    const marker = `${source.fileName}:local:${name}`
    if (!active(depth) || trail.has(marker)) {
      return null
    }
    const next = new Set([...trail, marker])
    const declarations = source.root.statements.filter(node => typeDeclaration(node) && node.name?.text === name)
    if (declarations.length) {
      return declarations.length === 1 ? { declaration: declarations[0], source } : ambiguous
    }
    const bindings = []
    for (const statement of source.root.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue
      }
      const clause = statement.importClause
      if (clause?.name?.text === name) {
        bindings.push({ specifier: statement.moduleSpecifier.text, name: 'default' })
      }
      const imports = clause?.namedBindings
      if (imports && ts.isNamedImports(imports)) {
        for (const element of imports.elements.filter(element => element.name.text === name)) {
          bindings.push({ specifier: statement.moduleSpecifier.text, name: element.propertyName?.text || element.name.text })
        }
      }
    }
    if (bindings.length !== 1) {
      return bindings.length ? ambiguous : null
    }
    const target = await moduleIndex(source, bindings[0].specifier)
    return target && await findExport(target, bindings[0].name, next, depth + 1)
  }

  async function reference(node, source, trail, depth) {
    if (node.typeArguments?.length) {
      return null
    }
    const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression
    if (name && ts.isIdentifier(name)) {
      return findLocal(source, name.text, trail, depth + 1)
    }
    if (name && ts.isQualifiedName(name) && ts.isIdentifier(name.left)) {
      const matches = source.root.statements.filter(statement => ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.name.text === name.left.text)
      if (matches.length === 1) {
        const target = await moduleIndex(source, matches[0].moduleSpecifier.text)
        return target && await findExport(target, name.right.text, trail, depth + 1)
      }
    }
    return null
  }

  async function resolve(node, source, trail = new Set(), depth = 0) {
    if (!node || !active(depth) || trail.has(node)) {
      return null
    }
    const next = new Set([...trail, node])
    if (ts.isParenthesizedTypeNode(node)) {
      return resolve(node.type, source, next, depth + 1)
    }
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const target = await reference(node, source, next, depth + 1)
      if (!target || target === ambiguous) {
        return null
      }
      return resolve(target.declaration, target.source, next, depth + 1)
    }
    if (typeDeclaration(node) && node.typeParameters?.length) {
      return null
    }
    if (ts.isTypeAliasDeclaration(node)) {
      return resolve(node.type, source, next, depth + 1)
    }
    return { declaration: node, source, trail: next, depth: depth + 1 }
  }

  async function members(node, source, trail, depth) {
    const target = await resolve(node, source, trail, depth)
    if (!target) {
      return null
    }
    const declaration = target.declaration
    if (ts.isIntersectionTypeNode(declaration)) {
      const entries = []
      for (const part of declaration.types) {
        const resolved = await members(part, target.source, target.trail, target.depth)
        if (!resolved) {
          return null
        }
        entries.push(...resolved)
      }
      // Conflicting intersection members need checker semantics; suppress them.
      return unambiguous(entries)
    }
    if (!ts.isInterfaceDeclaration(declaration) && !ts.isTypeLiteralNode(declaration)) {
      return null
    }
    const inherited = []
    for (const clause of declaration.heritageClauses || []) {
      for (const base of clause.types) {
        inherited.push(...(await members(base, target.source, target.trail, target.depth) || []))
      }
    }
    const own = declaration.members.filter(node => ts.isPropertySignature(node) && memberName(node))
      .map(node => ({ node, source: target.source }))
    const ownNames = new Set(own.map(entry => memberName(entry.node)))
    return [...unambiguous(inherited).filter(entry => !ownNames.has(memberName(entry.node))), ...unambiguous(own)]
  }

  async function literalType(node, source, trail, depth) {
    const target = await resolve(node, source, trail, depth)
    if (!target) {
      return null
    }
    if (ts.isUnionTypeNode(target.declaration)) {
      const types = []
      for (const part of target.declaration.types) {
        const values = await literalType(part, target.source, target.trail, target.depth)
        if (!values) {
          return null
        }
        types.push(...values)
      }
      return types
    }
    return [{ node: target.declaration, source: target.source }]
  }

  return {
    members: async (node, source) => (await members(node, source) || []).filter(entry => !entry.ambiguous),
    literalTypes: (node, source) => literalType(node, source)
  }
}

module.exports = { createTypeResolver }
