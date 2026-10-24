'use strict'

const path = require('node:path')
const ts = require('typescript')
const { parse, NodeTypes } = require('@vue/compiler-dom')

const stylesheetExtension = /\.(?:css|scss|less)$/i
const maxSourceLength = 256 * 1024

function literalToken(text, start, offset, kind) {
  for (const match of text.matchAll(/[^\t\n\f\r ]+/g)) {
    const at = start + match.index
    if (offset >= at && offset < at + match[0].length && !/[&\\]/.test(match[0])) {
      return { kind, name: match[0] }
    }
  }
  return null
}

function templateToken(index, offset) {
  for (const tag of index.tags || []) {
    if (offset < tag.start || offset >= tag.end) {
      continue
    }
    for (const attribute of tag.attributes) {
      if (offset < attribute.start || offset >= attribute.end) {
        continue
      }
      const raw = index.text.slice(attribute.start, attribute.end)
      const match = /^(class|id|:class|v-bind:class)\s*=\s*(?:"([\s\S]*)"|'([\s\S]*)'|([^\s>]+))$/.exec(raw)
      if (!match) {
        return null
      }
      const value = match[2] ?? match[3] ?? match[4]
      const start = attribute.start + raw.indexOf('=') + 1 + raw.slice(raw.indexOf('=') + 1).search(/\S/) +
        Number(match[4] === undefined)
      if (match[1] === 'class' || match[1] === 'id') {
        if (match[1] === 'id' && /[\t\n\f\r ]/.test(value)) {
          return null
        }
        return literalToken(value, start, offset, match[1])
      }
      // Entity or escape decoding would need a second source map. Abstain
      // rather than return a position belonging to a different literal.
      if (/[&\\]/.test(value) || value.length > 16384) {
        return null
      }
      const root = ts.createSourceFile('class.js', `(${value})`, ts.ScriptTarget.Latest, true)
      if (root.parseDiagnostics.length) {
        return null
      }
      let found = null
      function visit(node) {
        if (ts.isParenthesizedExpression(node)) {
          visit(node.expression)
        } else if (ts.isStringLiteral(node)) {
          found ||= literalToken(node.text, start + node.getStart(root), offset, 'class')
        } else if (ts.isArrayLiteralExpression(node)) {
          for (const element of node.elements) {
            visit(element)
          }
        } else if (ts.isObjectLiteralExpression(node)) {
          for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)) {
              continue
            }
            const name = property.name
            if (ts.isIdentifier(name)) {
              const at = start + name.getStart(root) - 1
              if (offset >= at && offset < at + name.text.length) {
                found ||= { kind: 'class', name: name.text }
              }
            } else if (ts.isStringLiteral(name)) {
              found ||= literalToken(name.text, start + name.getStart(root), offset, 'class')
            }
          }
        }
      }
      const expression = root.statements[0]?.expression
      if (expression) {
        visit(expression)
      }
      return found
    }
  }
  return null
}

// Preserve offsets while removing text which cannot introduce selectors.
function maskedSource(text, language) {
  const chars = text.split('')
  let quote = ''
  let comment = ''
  for (let at = 0; at < text.length; at++) {
    const current = text[at]
    const next = text[at + 1]
    if (comment) {
      chars[at] = ' '
      if (comment === 'block' && current === '*' && next === '/') {
        chars[++at] = ' '
        comment = ''
      } else if (comment === 'line' && (current === '\r' || current === '\n')) {
        comment = ''
      }
    } else if (quote) {
      chars[at] = ' '
      if (current === '\\' && at + 1 < text.length) {
        chars[++at] = ' '
      } else if (current === quote) {
        quote = ''
      }
    } else if (current === '/' && (next === '*' || (language !== 'css' && next === '/'))) {
      comment = next === '*' ? 'block' : 'line'
      chars[at] = chars[++at] = ' '
    } else if (current === '"' || current === "'") {
      quote = current
      chars[at] = ' '
    }
  }
  return chars.join('')
}

function identifier(text, at) {
  const start = at
  let name = ''
  while (at < text.length) {
    const current = text[at]
    if (/[\w-]/.test(current) || current.charCodeAt(0) >= 128) {
      name += current
      at++
    } else if (current === '\\' && at + 1 < text.length && !/[\r\n]/.test(text[at + 1])) {
      const hex = /^[\da-f]{1,6}/i.exec(text.slice(at + 1))
      if (hex) {
        const cp = Number.parseInt(hex[0], 16)
        name += String.fromCodePoint(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp)
        at += hex[0].length + 1
        if (/\s/.test(text[at] || '')) {
          at++
        }
      } else {
        name += text[++at]
        at++
      }
    } else {
      break
    }
  }
  return { name, start, end: at }
}

function selectorDefinitions(masked, start, end, token) {
  const result = []
  let brackets = 0
  for (let at = start; at < end; at++) {
    const current = masked[at]
    if (current === '[') {
      brackets++
    } else if (current === ']') {
      brackets = Math.max(0, brackets - 1)
    } else if (current === '\\') {
      at = identifier(masked, at).end - 1
    } else if (!brackets && current === (token.kind === 'class' ? '.' : '#')) {
      const name = identifier(masked, at + 1)
      if (name.name === token.name) {
        result.push({ start: at, length: name.end - at })
      }
      at = Math.max(at, name.end - 1)
    }
  }
  return result
}

function importSpecifiers(raw) {
  // Only quoted relative imports or url("relative") are supported; skip the
  // rest of an @import prelude (media queries, layer and supports clauses).
  const result = []
  const expression = /(?:^|,)\s*(?:url\(\s*)?(?:"([^"]+)"|'([^']+)')\s*\)?/g
  for (const match of raw.matchAll(expression)) {
    result.push(match[1] || match[2])
  }
  return result
}

function scanStyles(text, language, token, cancelled) {
  const masked = maskedSource(text, language)
  const definitions = []
  const imports = []
  const stack = [{ allowed: true }]
  let start = 0
  let brackets = 0
  let parens = 0
  for (let at = 0; at < masked.length; at++) {
    if ((at & 4095) === 0 && cancelled()) {
      return { definitions: [], imports: [] }
    }
    const current = masked[at]
    if (current === '\\') {
      at = identifier(masked, at).end - 1
      continue
    }
    if (current === '[') {
      brackets++
    } else if (current === ']') {
      brackets = Math.max(0, brackets - 1)
    } else if (current === '(') {
      parens++
    } else if (current === ')') {
      parens = Math.max(0, parens - 1)
    }
    if (brackets || parens) {
      continue
    }
    if (current === '{') {
      const prelude = masked.slice(start, at).trim()
      // Interpolated selectors and declarations containing blocks are not
      // static definitions. Consume interpolation braces without splitting
      // their surrounding selector into a misleading partial name.
      if (masked[at - 1] === '#' || masked[at - 1] === '@') {
        let depth = 1
        while (depth && ++at < masked.length) {
          if (masked[at] === '{') {
            depth++
          } else if (masked[at] === '}') {
            depth--
          }
        }
        // Suppress the complete selector containing this interpolation.
        stack[stack.length - 1].interpolated = true
        continue
      }
      const parent = stack[stack.length - 1]
      const atRule = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase()
      const container = atRule && ['media', 'supports', 'layer', 'container', 'document', 'scope', 'starting-style'].includes(atRule)
      const variable = /^(?:--[\w-]+|[$@][\w-]+)\s*:/.test(prelude)
      const mixin = language === 'less' && /^[.#][\w-]+\s*\(/.test(prelude)
      const allowed = parent.allowed && !variable && !mixin && (!atRule || container)
      if (allowed && !atRule && !parent.interpolated) {
        definitions.push(...selectorDefinitions(masked, start, at, token))
      }
      parent.interpolated = false
      stack.push({ allowed })
      start = at + 1
    } else if (current === ';' || current === '}') {
      if (stack[stack.length - 1].allowed && /^\s*@import\b/i.test(masked.slice(start, at))) {
        const marker = /@import\b/i.exec(masked.slice(start, at))
        imports.push(...importSpecifiers(text.slice(start + marker.index + marker[0].length, at)))
      }
      if (current === '}' && stack.length > 1) {
        stack.pop()
      }
      stack[stack.length - 1].interpolated = false
      start = at + 1
    }
  }
  return { definitions, imports }
}

function styleSource(index, block) {
  const opening = /<style\b(?:[^"'<>]|"[^"]*"|'[^']*')*>$/i.exec(index.text.slice(Math.max(0, block.start - 16384), block.start))
  if (!opening) {
    return null
  }
  for (const attribute of opening[0].matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (attribute[1] === 'src') {
      return attribute[2] ?? attribute[3] ?? attribute[4] ?? null
    }
  }
  return null
}

function selfClosingStyleSources(text) {
  // The shared index deliberately excludes self-closing SFC blocks. Parse
  // only when needed, and only inspect top-level nodes so examples inside
  // comments, script strings or the template cannot become stylesheet reads.
  if (!/<style\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/>/i.test(text) || text.length > 2 * 1024 * 1024) {
    return []
  }
  let root
  try {
    root = parse(text, { onError() {} })
  } catch {
    return []
  }
  const result = []
  for (const node of root.children) {
    if (node.type !== NodeTypes.ELEMENT || node.tag !== 'style' || !node.isSelfClosing) {
      continue
    }
    const lang = node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'lang')?.value?.content
    const src = node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'src')?.value?.content
    if (src && ['css', 'scss', 'less'].includes(lang || 'css')) {
      result.push(src)
    }
  }
  return result
}

async function findStyleDefinitions(index, offset, context = {}) {
  const cancelled = () => Boolean(context.isCancelled?.())
  if (cancelled() || !index || !Number.isInteger(offset)) {
    return []
  }
  const token = templateToken(index, offset)
  if (!token) {
    return []
  }
  const result = []
  const queue = []
  const seen = new Set()
  let reads = 0
  let sources = 0
  let total = 0
  const scan = (text, language, fileName, base, depth) => {
    const bytes = text.length > maxSourceLength ? Infinity : Buffer.byteLength(text, 'utf8')
    if (bytes > maxSourceLength || sources >= 32 || total + bytes > 2 * 1024 * 1024 || cancelled()) {
      return
    }
    sources++
    total += bytes
    const parsed = scanStyles(text, language, token, cancelled)
    for (const span of parsed.definitions) {
      result.push({ fileName, textSpan: { start: base + span.start, length: span.length } })
    }
    for (const specifier of parsed.imports) {
      queue.push({ specifier, from: fileName, depth: depth + 1 })
    }
  }
  for (const block of index.blocks || []) {
    if (block.tag !== 'style' || !['css', 'scss', 'less'].includes(block.lang || 'css')) {
      continue
    }
    if (block.external) {
      queue.push({ specifier: styleSource(index, block), from: index.fileName, depth: 0 })
    } else {
      scan(index.text.slice(block.start, block.end), block.lang || 'css', index.fileName, block.start, 0)
    }
  }
  for (const specifier of selfClosingStyleSources(index.text)) {
    queue.push({ specifier, from: index.fileName, depth: 0 })
  }
  for (const statement of index.root?.statements || []) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.importClause?.isTypeOnly && stylesheetExtension.test(statement.moduleSpecifier.text)) {
      queue.push({ specifier: statement.moduleSpecifier.text, from: index.fileName, depth: 0 })
    }
  }
  for (let at = 0; at < queue.length && reads < 64 && sources < 32; at++) {
    if (cancelled()) {
      return []
    }
    const entry = queue[at]
    const specifier = entry.specifier
    if (entry.depth > 8 || typeof specifier !== 'string' || specifier.length > 4096 ||
      (!context.resolveStyleFile && !/^\.\.?\//.test(specifier)) || /[\0\r\n\\!?#]/.test(specifier) || !path.isAbsolute(entry.from)) {
      continue
    }
    const probe = async candidate => {
      const extension = path.extname(candidate)
      const candidates = stylesheetExtension.test(candidate) ? [candidate] :
        extension ? [] : ['.css', '.scss', '.less'].map(suffix => candidate + suffix)
      for (const fileName of candidates) {
        if (seen.has(fileName) || reads >= 64 || cancelled()) continue
        seen.add(fileName)
        reads++
        let text
        try { text = await context.readFile?.(fileName) } catch { text = null }
        if (cancelled()) return null
        if (typeof text === 'string') return { fileName, text }
      }
      return null
    }
    const found = context.resolveStyleFile ? await context.resolveStyleFile(specifier, entry.from, probe) :
      await probe(path.resolve(path.dirname(entry.from), specifier))
    if (cancelled()) return []
    if (found) scan(found.text, path.extname(found.fileName).slice(1).toLowerCase(), found.fileName, 0, entry.depth)
  }
  if (cancelled()) {
    return []
  }
  const unique = new Map(result.map(location => [`${location.fileName}:${location.textSpan.start}`, location]))
  return [...unique.values()]
}

module.exports = { findStyleDefinitions }
