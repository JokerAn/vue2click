'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const ts = require('typescript')
const { within, ancestors, configCandidates } = require('./project-config')

// Read configuration as data only. In particular, do not require project config
// files: webpack/Vue configuration can execute arbitrary application code.
const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue']
const declarations = /\.d\.(?:ts|mts|cts)$/i
const supported = /\.(?:vue|js|ts|jsx|tsx|mjs|cjs)$/i

function cleanSpecifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\0\r\n!?#]/.test(value) && !/^[a-z][\w+.-]*:/i.test(value) && !value.includes('\\')
}

/** Resolve a static module import without evaluating any project code. */
async function resolveStaticPath(specifier, fromFile, options = {}) {
  try {
    if (!cleanSpecifier(specifier) || typeof fromFile !== 'string' || !path.isAbsolute(fromFile)) return null
    const read = options.readFile || (file => fs.readFile(file, 'utf8'))
    const exists = options.isFile || (async file => (await fs.stat(file)).isFile())
    const fileCache = new Map()
    const textCache = new Map()
    const isFile = async file => {
      if (!fileCache.has(file)) fileCache.set(file, Promise.resolve().then(() => exists(file)).then(Boolean, () => false))
      return fileCache.get(file)
    }
    const text = async file => {
      if (!textCache.has(file)) textCache.set(file, Promise.resolve().then(() => read(file)).then(value => typeof value === 'string' ? value : null, () => null))
      return textCache.get(file)
    }
    const json = async file => {
      const contents = await text(file)
      if (contents === null) return null
      const parsed = ts.parseConfigFileTextToJson(file, contents)
      return parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config) ? null : parsed.config
    }
    const probe = options.probe || (async candidate => {
      candidate = path.resolve(candidate)
      if (declarations.test(candidate)) return null
      if (supported.test(candidate)) {
        if (await isFile(candidate)) return candidate
        // NodeNext-style source imports commonly spell a .ts source as .js.
        const alternatives = /\.js$/i.test(candidate) ? ['.ts', '.tsx'] : /\.jsx$/i.test(candidate) ? ['.tsx'] : []
        for (const extension of alternatives) {
          const file = candidate.replace(/\.[^.]+$/, extension)
          if (await isFile(file)) return file
        }
        return null
      }
      // An explicit unsupported extension is never a component source.
      if (path.extname(candidate)) return null
      for (const extension of extensions) if (await isFile(candidate + extension)) return candidate + extension
      for (const extension of extensions) {
        const file = path.join(candidate, 'index' + extension)
        if (await isFile(file)) return file
      }
      return null
    })

    const fromDirectory = path.dirname(fromFile)
    const root = typeof options.workspaceRoot === 'string' && path.isAbsolute(options.workspaceRoot) && within(options.workspaceRoot, fromFile)
      ? path.resolve(options.workspaceRoot) : undefined
    const directories = ancestors(fromDirectory, root)

    // Resolve package metadata ourselves so types-only entries never hide the
    // actual implementation. Reading package.json does not execute the package.
    const packageParts = value => {
      const pieces = value.split('/')
      const count = value.startsWith('@') ? 2 : 1
      if (pieces.length < count || pieces.some(piece => !piece || piece === '.' || piece === '..')) return null
      return { name: pieces.slice(0, count).join('/'), subpath: pieces.slice(count).join('/') }
    }
    const locatePackage = async (value, directory) => {
      const parts = packageParts(value)
      if (!parts) return null
      for (const ancestor of ancestors(directory)) {
        const packageRoot = path.join(ancestor, 'node_modules', parts.name)
        const manifest = await json(path.join(packageRoot, 'package.json'))
        if (manifest || await isFile(path.join(packageRoot, 'index.js'))) return { ...parts, packageRoot, manifest: manifest || {} }
      }
      return null
    }

    // A depth guard alone does not bound repeated branches such as
    // extends: ['./next.json', './next.json']. Spend one shared budget on both
    // config visits and extends entries, including entries that cannot resolve.
    // Abort the whole resolution when exhausted so partially merged paths or
    // default src aliases cannot produce a misleading definition location.
    let configBudget = 256
    const substituteConfigDir = (value, directory) => value.toLowerCase().startsWith('${configdir}')
      ? path.resolve(directory, value.replace('${configDir}', './')) : value
    const spendConfigBudget = () => {
      if (configBudget-- <= 0) throw new Error('Configuration traversal limit exceeded')
    }
    const loadConfig = async (file, seen = new Set(), configDirectory = path.dirname(file)) => {
      spendConfigBudget()
      if (seen.has(file)) return {}
      if (seen.size >= 32) throw new Error('Configuration inheritance depth limit exceeded')
      const branch = new Set(seen).add(file)
      const config = await json(file)
      if (!config) return {}
      const directory = path.dirname(file)
      let inherited = {}
      const bases = typeof config.extends === 'string' ? [config.extends] : Array.isArray(config.extends) ? config.extends : []
      for (const base of bases) {
        spendConfigBudget()
        if (!cleanSpecifier(base)) continue
        let configFile
        if (base.startsWith('.') || path.isAbsolute(base)) {
          configFile = path.resolve(directory, base)
          if (!path.extname(configFile)) configFile += '.json'
        } else {
          const located = await locatePackage(base, directory)
          if (located) {
            configFile = path.resolve(located.packageRoot, located.subpath || located.manifest.tsconfig || 'tsconfig.json')
            if (!within(located.packageRoot, configFile)) continue
            if (!path.extname(configFile)) configFile += '.json'
          }
        }
        if (configFile) {
          const parent = await loadConfig(configFile, branch, configDirectory)
          inherited = { ...inherited, ...parent }
        }
      }
      const compiler = config.compilerOptions && typeof config.compilerOptions === 'object' ? config.compilerOptions : {}
      const result = { ...inherited }
      if (typeof compiler.baseUrl === 'string') result.baseUrl = path.resolve(directory, substituteConfigDir(compiler.baseUrl, configDirectory))
      if (compiler.paths && typeof compiler.paths === 'object' && !Array.isArray(compiler.paths)) {
        result.mappings = Object.entries(compiler.paths).map(([pattern, targets]) => ({
          pattern,
          targets: Array.isArray(targets) ? targets.filter(target => typeof target === 'string')
            .map(target => substituteConfigDir(target, configDirectory)) : [],
          directory
        }))
      }
      return result
    }

    if (path.isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
      return await probe(path.resolve(fromDirectory, specifier))
    }

    let config = { mappings: [] }
    for (const configFile of configCandidates(fromFile, root)) {
      if (await isFile(configFile) || await text(configFile) !== null) {
        config = await loadConfig(configFile)
        break
      }
    }
    const matches = []
    for (const mapping of config.mappings || []) {
      const parts = mapping.pattern.split('*')
      if (parts.length > 2) continue
      if (parts.length === 1 && mapping.pattern === specifier) matches.push({ mapping, replacement: '', rank: Infinity })
      else if (parts.length === 2 && specifier.startsWith(parts[0]) && specifier.endsWith(parts[1]) && specifier.length >= parts[0].length + parts[1].length) {
        matches.push({ mapping, replacement: specifier.slice(parts[0].length, specifier.length - parts[1].length), rank: parts[0].length })
      }
    }
    matches.sort((a, b) => b.rank - a.rank)
    if (matches.length) {
      // TypeScript selects the most specific pattern; try its targets in order.
      const { mapping, replacement } = matches[0]
      for (const target of mapping.targets) {
        if (!cleanSpecifier(target) || target.split('*').length > 2) continue
        const hit = await probe(path.resolve(config.baseUrl || mapping.directory, target.replace('*', replacement)))
        if (hit) return hit
      }
      return null
    }

    if (config.baseUrl) {
      const hit = await probe(path.resolve(config.baseUrl, specifier))
      if (hit) return hit
    }
    if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
      const prefix = specifier[0]
      // Explicit alias definitions are authoritative, including a missing target.
      if ((config.mappings || []).some(({ pattern }) => pattern === prefix || pattern.startsWith(prefix + '/'))) return null
      for (const directory of directories) {
        const src = path.join(directory, 'src')
        const file = path.resolve(src, specifier.slice(2))
        if (!within(src, file)) return null
        const hit = await probe(file, false)
        if (hit) return hit
        // Stop at the nearest project src, even if the requested file is absent.
        try { if ((await fs.stat(src)).isDirectory()) return null } catch (_) {}
      }
      return null
    }

    if (options.relativeFallback && !/^[@~]/.test(specifier)) {
      const hit = await probe(path.resolve(fromDirectory, specifier), false)
      if (hit) return hit
    }
    if (options.allowPackages === false) return null
    const located = await locatePackage(specifier, fromDirectory)
    if (!located) return null
    const { packageRoot, manifest, subpath } = located
    const packageTarget = async target => {
      if (typeof target !== 'string' || !cleanSpecifier(target)) return null
      const file = path.resolve(packageRoot, target)
      return within(packageRoot, file) ? probe(file) : null
    }
    const exportTarget = async target => {
      if (typeof target === 'string') return target.startsWith('./') ? packageTarget(target) : null
      if (Array.isArray(target)) {
        for (const entry of target) { const hit = await exportTarget(entry); if (hit) return hit }
      } else if (target && typeof target === 'object') {
        for (const key of ['import', 'module', 'browser', 'require', 'node', 'default']) {
          if (Object.prototype.hasOwnProperty.call(target, key)) {
            const hit = await exportTarget(target[key])
            if (hit) return hit
          }
        }
      }
      return null
    }
    if (Object.prototype.hasOwnProperty.call(manifest, 'exports')) {
      const exports = manifest.exports
      const key = subpath ? './' + subpath : '.'
      if (exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(name => name.startsWith('.'))) {
        if (Object.prototype.hasOwnProperty.call(exports, key)) return await exportTarget(exports[key])
        const patterns = Object.keys(exports).filter(name => name.split('*').length === 2).sort((a, b) => b.indexOf('*') - a.indexOf('*'))
        for (const pattern of patterns) {
          const [before, after] = pattern.split('*')
          if (!key.startsWith(before) || !key.endsWith(after) || key.length < before.length + after.length) continue
          const replacement = key.slice(before.length, key.length - after.length)
          const replace = target => typeof target === 'string' ? target.replaceAll('*', replacement)
            : Array.isArray(target) ? target.map(replace)
              : target && typeof target === 'object' ? Object.fromEntries(Object.entries(target).map(([name, value]) => [name, replace(value)])) : target
          return await exportTarget(replace(exports[pattern]))
        }
        return null
      }
      return key === '.' ? await exportTarget(exports) : null
    }
    if (subpath) return await packageTarget(subpath)
    for (const field of ['vue', 'module', 'main']) {
      const hit = await packageTarget(manifest[field])
      if (hit) return hit
    }
    return await probe(path.join(packageRoot, 'index'))
  } catch (_) {
    return null
  }
}

function resolveModulePath(specifier, fromFile, options = {}) {
  return resolveStaticPath(specifier, fromFile, options)
}

/** Share only IO results during one definition request, never across requests. */
function createModuleResolver(options = {}) {
  const read = options.readFile || (file => fs.readFile(file, 'utf8'))
  const exists = options.isFile || (async file => (await fs.stat(file)).isFile())
  const texts = new Map()
  const files = new Map()
  const session = {
    ...options,
    readFile(file) {
      if (!texts.has(file)) texts.set(file, Promise.resolve().then(() => read(file)).then(value => typeof value === 'string' ? value : null, () => null))
      return texts.get(file)
    },
    isFile(file) {
      if (!files.has(file)) files.set(file, Promise.resolve().then(() => exists(file)).then(Boolean, () => false))
      return files.get(file)
    }
  }
  return async (specifier, fromFile) => resolveModulePath(specifier, fromFile, session)
}

module.exports = { resolveModulePath, resolveStaticPath, createModuleResolver }
