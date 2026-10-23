'use strict'

const path = require('node:path')
const ts = require('typescript')
const { componentOptions, property, initializer, localObject, key } = require('./components')
const { kebab } = require('./component-info')
const componentFilesCache = new WeakMap()
const importCache = new WeakMap()

function componentName(file) {
  const basename = path.basename(file, '.vue')
  const raw = basename.toLowerCase() === 'index' ? path.basename(path.dirname(file)) : basename
  const name = raw.replace(/(?:^|[-_.\s]+)([a-zA-Z0-9])/g, (_, letter) => letter.toUpperCase()).replace(/[^\w$]/g, '')
  return /^[A-Z_$][\w$]*$/.test(name) ? name : null
}

function importComponent(index, file, desiredName, resolvedImport) {
  const block = index.blocks.find(block => block.tag === 'script' && !block.external)
  if (!block || index.root.parseDiagnostics.length || file === index.fileName) {
    return null
  }
  const options = !index.scriptSetup && componentOptions(index)
  const declaration = property(options, 'components')
  const components = localObject(index, initializer(declaration))
  if (!index.scriptSetup && (!options || declaration &&
    (!components || components.properties.some(prop => ts.isSpreadAssignment(prop) || key(prop) === null)))) {
    return null
  }
  const existingImport = resolvedImport || index.imports.find(binding => binding.symbol === 'default' &&
    path.resolve(path.dirname(index.fileName), binding.specifier) === file)
  let name = existingImport?.local.text || desiredName
  const occupied = new Set(index.bindings.map(binding => binding.name).concat(
    index.imports.map(binding => binding.local.text), (components?.properties || []).map(key)))
  const registeredNames = new Set((components?.properties || []).map(prop => kebab(key(prop))))
  if (!existingImport) {
    let suffix = 2
    while (occupied.has(name) || registeredNames.has(kebab(name))) {
      name = desiredName + suffix++
    }
  }
  const edits = []
  const nl = index.text.includes('\r\n') ? '\r\n' : '\n'
  const imports = index.root.statements.filter(ts.isImportDeclaration)
  const quote = imports[0]?.moduleSpecifier.getText(index.root)[0] || "'"
  const semi = imports[0]?.getText(index.root).endsWith(';') ? ';' : ''
  if (!existingImport) {
    let relative = path.relative(path.dirname(index.fileName), file).replace(/\\/g, '/')
    if (!relative.startsWith('.')) {
      relative = './' + relative
    }
    const start = imports.at(-1)?.end ?? block.start
    edits.push({ span: { start, length: 0 }, newText: `${nl}import ${name} from ${quote}${relative}${quote}${semi}${nl}` })
  }
  if (!index.scriptSetup) {
    if (components) {
      const registered = components.properties.find(prop => kebab(key(prop)) === kebab(name))
      const binding = name
      if (registered && initializer(registered)?.getText(index.root) !== binding) {
        let suffix = 2
        while (occupied.has(name) || registeredNames.has(kebab(name))) {
          name = binding + suffix++
        }
      }
      if (!registered || name !== binding) {
        const at = components.end - 1
        const registration = name === binding ? name : `${name}: ${binding}`
        edits.push({ span: { start: at, length: 0 }, newText: `${components.properties.length && !components.properties.hasTrailingComma ? ',' : ''} ${registration} ` })
      }
    } else {
      edits.push({ span: { start: options.getStart(index.root) + 1, length: 0 }, newText: `${nl}  components: { ${name} },` })
    }
  }
  return { name, changes: [{ fileName: index.fileName, textChanges: edits }] }
}

async function componentCandidates(index, files, prefix, resolveModule, revision = 0) {
  let indexed = componentFilesCache.get(files)
  if (!indexed) {
    indexed = []
    for (const file of files) {
      if (!file.endsWith('.vue')) {
        continue
      }
      const name = componentName(file)
      if (name) {
        for (const key of new Set([name.toLowerCase(), kebab(name).toLowerCase()])) {
          indexed.push({ file, name, key })
        }
      }
    }
    indexed.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file))
    componentFilesCache.set(files, indexed)
  }
  const normalizedPrefix = prefix.toLowerCase()
  const candidates = new Map()
  let low = 0
  let high = indexed.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (indexed[middle].key < normalizedPrefix) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  for (let cursor = low; cursor < indexed.length && indexed[cursor].key.startsWith(normalizedPrefix); cursor++) {
    const entry = indexed[cursor]
    if (entry.file !== index.fileName) {
      candidates.set(entry.file, entry.name)
      if (candidates.size >= 100) {
        break
      }
    }
  }
  if (!candidates.size) {
    return []
  }
  let cached = importCache.get(index)
  if (!cached || cached.revision !== revision) {
    const promise = (async () => {
      const imports = new Map()
      for (const binding of index.imports.filter(binding => binding.symbol === 'default')) {
        const file = await resolveModule?.(binding.specifier, index.fileName) || path.resolve(path.dirname(index.fileName), binding.specifier)
        if (file) {
          imports.set(path.resolve(file), binding)
        }
      }
      return imports
    })()
    cached = { revision, promise }
    importCache.set(index, cached)
  }
  const imports = await cached.promise
  return (await Promise.all([...candidates].map(async ([file, desired]) => {
    const imported = importComponent(index, file, desired, imports.get(path.resolve(file)))
    if (!imported || !imported.changes[0].textChanges.length) {
      return null
    }
    return { name: prefix.includes('-') ? kebab(imported.name) : imported.name, kind: 'class',
      detail: `Import component (${path.relative(path.dirname(index.fileName), file)})`,
      documentation: 'Import this component and register it in the current Vue component.',
      changes: imported.changes }
  }))).filter(Boolean)
}

module.exports = { componentCandidates, importComponent, componentName }
