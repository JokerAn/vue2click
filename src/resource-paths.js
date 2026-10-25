'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const ts = require('typescript')
const { resolveStaticPath } = require('./module-paths')

const isSourceFile = value => /\.(?:vue|[cm]?[jt]sx?)$/i.test(value)
const localReference = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
  !value.startsWith('//') && !/^[a-z][\w+.-]*:/i.test(value) && !/[\0\r\n\\!?#]/.test(value) && !value.includes('${')

const urlContext = {
  resolveReference(reference, base) {
    try {
      const target = new URL(reference, base)
      return ['file:', 'http:', 'https:'].includes(target.protocol) ? target.toString() : undefined
    } catch { return undefined }
  }
}

function createResourceResolver(options = {}) {
  const cancelled = () => Boolean(options.isCancelled?.())
  const texts = new Map()
  const stats = new Map()
  const read = options.readFile || (file => fs.readFile(file, 'utf8'))
  const stat = file => {
    if (!stats.has(file)) stats.set(file, fs.stat(file).catch(() => null))
    return stats.get(file)
  }
  const session = {
    workspaceRoot: options.workspaceRoot,
    allowPackages: false,
    relativeFallback: true,
    readFile(file) {
      if (!texts.has(file)) texts.set(file, Promise.resolve().then(() => read(file)).catch(() => null))
      return texts.get(file)
    },
    isFile: async file => options.isFile ? options.isFile(file) : Boolean((await stat(file))?.isFile())
  }
  async function resolveWith(specifier, fromFile, probe) {
    if (cancelled() || !localReference(specifier)) return null
    const result = await resolveStaticPath(specifier, fromFile, { ...session, probe: async candidate => cancelled() ? null : probe(candidate) })
    return cancelled() ? null : result
  }
  async function completePaths(specifier, fromFile) {
    if (cancelled() || (specifier !== '' && !localReference(specifier))) return { items: [] }
    const slash = specifier.lastIndexOf('/')
    const directoryReference = slash >= 0 ? specifier.slice(0, slash + 1) : './'
    const prefix = specifier.slice(slash + 1)
    const resolved = await resolveWith(directoryReference, fromFile, async candidate =>
      (await stat(candidate))?.isDirectory() ? { directory: candidate } : null)
    if (!resolved || cancelled()) return { items: [] }
    try {
      const entries = await (options.readDirectory || (file => fs.readdir(file, { withFileTypes: true })))(resolved.directory)
      if (cancelled()) return { items: [] }
      const items = entries.filter(entry => entry.name.startsWith(prefix) && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500)
        .map(entry => ({ name: entry.name + (entry.isDirectory() ? '/' : ''), kind: entry.isDirectory() ? 'folder' : 'file' }))
      return { ...resolved, items }
    } catch {
      return { ...resolved, items: [] }
    }
  }
  return {
    resolve: (specifier, fromFile) => resolveWith(specifier, fromFile, async candidate =>
      await session.isFile(candidate) ? candidate : null),
    resolveStyleFile: (specifier, fromFile, probe) => resolveWith(specifier, fromFile, probe),
    resolveStylesheet: (specifier, fromFile, language) => resolveWith(specifier, fromFile, async candidate => {
      const extension = path.extname(candidate)
      if (extension) {
        return /\.(css|scss|less)$/i.test(extension) && await session.isFile(candidate) ? candidate : null
      }
      if (await session.isFile(candidate)) return candidate
      const extensions = language === 'scss' ? ['.scss', '.css'] : language === 'less' ? ['.less', '.css'] : ['.css']
      const matches = []
      for (const suffix of extensions) {
        if (cancelled()) return null
        if (await session.isFile(candidate + suffix)) matches.push(candidate + suffix)
      }
      return matches.length === 1 ? matches[0] : null
    }),
    completePaths,
    complete: async (specifier, fromFile) => (await completePaths(specifier, fromFile)).items
  }
}

function resourceReferences(index, entries) {
  const result = []
  for (const entry of entries) {
    const links = entry.language === 'html' ? entry.service.findDocumentLinks(entry.document, urlContext) :
      entry.service.findDocumentLinks(entry.document, entry.parsed, urlContext)
    for (const link of links) {
      let start = entry.document.offsetAt(link.range.start)
      let end = Math.min(entry.document.offsetAt(link.range.end), entry.block.end)
      let closed = true
      if (/^["']/.test(index.text[start])) {
        closed = index.text[end - 1] === index.text[start]
        start++
        if (closed) end--
      } else if (/^["']/.test(index.text[start - 1])) {
        closed = index.text[end] === index.text[start - 1]
      }
      result.push({ start, end, closed, reference: index.text.slice(start, end), target: link.target })
    }
  }
  for (const source of index.blockSources || []) {
    if (source.tag === 'style' && ['css', 'scss', 'less'].includes(source.lang || 'css')) result.push(source)
  }
  for (const tag of index.tags || []) {
    for (const attribute of tag.attributes) {
      const raw = index.text.slice(attribute.start, attribute.end)
      const match = /^(src|href|poster|xlink:href)\s*=\s*(["'])([\s\S]*)\2$/.exec(raw)
      if (!match || match[3] !== '') continue
      const start = attribute.end - match[3].length - 1
      result.push({ reference: match[3], start, end: attribute.end - 1 })
    }
  }
  for (const statement of index.root?.statements || []) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const node = statement.moduleSpecifier
    const start = node.getStart(index.root) + 1
    const block = index.blocks.find(value => value.tag === 'script' && start >= value.start && start <= value.end)
    const closed = index.text[node.end - 1] === index.text[start - 1]
    const end = closed ? node.end - 1 : Math.min(node.end, block?.end ?? node.end)
    const reference = index.text.slice(start, end)
    result.push({ reference, start, end, closed, sourceModule: !path.extname(reference) || isSourceFile(reference) })
  }
  const safe = result.filter(value => {
    const scheme = /^([a-z][\w+.-]*):/i.exec(value.reference.trimStart())?.[1]
    return !scheme || ['http', 'https', 'file'].includes(scheme.toLowerCase())
  })
  return [...new Map(safe.map(value => [`${value.start}:${value.end}`, value])).values()]
}

module.exports = { createResourceResolver, resourceReferences, localReference, urlContext, isSourceFile }
