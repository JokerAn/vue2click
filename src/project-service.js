'use strict'

const ts = require('typescript')
const vue = require('@vue/language-core')
const { decorateLanguageServiceHost, createProxyLanguageService, resolveFileLanguageId } = require('@volar/typescript')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildIndex } = require('./resolver')
const { createModuleResolver } = require('./module-paths')
const { createIndirectService } = require('./indirect')
const { createProjectFiles } = require('./project-files')
const { findNearestConfig, fileStamp } = require('./project-config')

const normalize = file => path.resolve(file).replace(/\\/g, '/')
const parts = value => ts.displayPartsToString(value || [])

// This module runs in a worker. Project parsing never executes workspace code.
function createProjectService(root, firstFile, libDirectory) {
  root = normalize(root)
  const buffers = new Map()
  const disk = new Map()
  let projectVersion = 0
  const config = findNearestConfig(firstFile, root)
  const configRoot = config ? path.dirname(config) : root
  let rawConfig = {}
  let configErrors = []
  const configuration = new Map()
  function trackConfig(file) {
    file = normalize(file)
    if (!configuration.has(file)) {
      if (configuration.size >= 512) throw new Error('Configuration dependency limit exceeded')
      configuration.set(file, fileStamp(file))
    }
  }
  const configHost = {
    ...ts.sys,
    fileExists(file) {
      if (file.endsWith('.json')) trackConfig(file)
      return ts.sys.fileExists(file)
    },
    readFile(file) {
      trackConfig(file)
      return ts.sys.readFile(file)
    }
  }
  if (config) {
    const result = ts.readConfigFile(config, configHost.readFile)
    rawConfig = result.config || {}
    if (result.error) {
      configErrors.push(result.error)
    }
  }
  const projectFilesHost = createProjectFiles(configRoot)
  const parsed = ts.parseJsonConfigFileContent(rawConfig, { ...configHost, readDirectory: projectFilesHost.readDirectory }, configRoot, undefined, config, undefined,
    [{ extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }])
  configErrors.push(...parsed.errors)
  const options = {
    allowJs: true, checkJs: true, strict: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10, jsx: ts.JsxEmit.Preserve,
    ...parsed.options, noEmit: true, allowNonTsExtensions: true
  }
  const roots = new Set(parsed.fileNames.map(normalize))
  if (!config) {
    options.types = []
  }
  // Git supplies ignored-file filtering for inferred projects and global registration scans.
  let projectFiles
  try {
    const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    }).split('\0').filter(Boolean)
    projectFiles = listed.map(file => normalize(path.join(root, file.startsWith(prefix) ? file.slice(prefix.length) : file)))
      .filter(file => /\.(vue|[cm]?[jt]sx?)$/.test(file) && !/(?:^|\/)(?:node_modules|\.git)\//.test(file))
      .filter(file => !projectFilesHost.ignored(file))
  } catch {
    projectFiles = [...roots]
  }
  if (!config) {
    roots.clear()
    for (const file of projectFiles) {
      if (file.startsWith(root + '/')) {
        roots.add(file)
      }
    }
  }
  roots.add(normalize(firstFile))
  let componentFiles = new Set([...roots].filter(file => file.endsWith('.vue')))
  let target = 2.7
  for (let directory = path.dirname(firstFile);;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules/vue/package.json'), 'utf8'))
      const [major, minor] = pkg.version.split('.').map(Number)
      target = major < 3 ? (minor >= 7 ? 2.7 : 2) : major + minor / 10
      break
    } catch {}
    const parent = path.dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  const typesFile = normalize(path.join(configRoot, '.vueclick-internal-types.d.ts'))
  const rawVue = rawConfig.vueCompilerOptions || {}
  const vueOptions = {
    ...vue.getDefaultCompilerOptions(Number(rawVue.target) || target),
    strictTemplates: rawVue.strictTemplates ?? true,
    checkUnknownProps: rawVue.strictTemplates ?? true,
    checkUnknownEvents: rawVue.strictTemplates ?? true,
    inferComponentDollarRefs: true, inferTemplateDollarRefs: true,
    globalTypesPath: () => typesFile
  }
  const generatedTypes = vue.generateGlobalTypes(vueOptions)
  const staticFiles = new Map([[typesFile, ts.ScriptSnapshot.fromString(generatedTypes)]])
  roots.add(typesFile)
  function read(file) {
    file = normalize(file)
    if (buffers.has(file)) {
      return buffers.get(file)
    }
    const snapshot = staticFiles.get(file)
    if (snapshot) {
      return { version: 'internal', snapshot }
    }
    try {
      const stat = fs.statSync(file)
      const version = `${stat.mtimeMs}:${stat.size}`
      let entry = disk.get(file)
      if (!entry || entry.version !== version) {
        entry = { version, snapshot: ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8')) }
        disk.set(file, entry)
      }
      return entry
    } catch {
      disk.delete(file)
      return undefined
    }
  }
  const host = {
    ...ts.sys,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => configRoot,
    getCompilationSettings: () => options,
    getProjectVersion: () => String(projectVersion),
    getScriptFileNames: () => [...roots],
    getScriptVersion: file => read(file)?.version || 'missing',
    getScriptSnapshot: file => read(file)?.snapshot,
    getScriptKind: file => file.endsWith('.vue') ? ts.ScriptKind.Deferred : ts.getScriptKindFromFileName(file),
    getDefaultLibFileName: settings => libDirectory
      ? path.join(libDirectory, ts.getDefaultLibFileName(settings)) : ts.getDefaultLibFilePath(settings),
    fileExists: file => staticFiles.has(normalize(file)) || buffers.has(normalize(file)) || ts.sys.fileExists(file),
    readFile: file => {
      const snapshot = read(file)?.snapshot
      return snapshot?.getText(0, snapshot.getLength())
    },
    resolveModuleNames: (names, from) => names.map(name => ts.resolveModuleName(name, from, options, host).resolvedModule)
  }
  let language
  language = vue.createLanguage([
    vue.createVueLanguagePlugin(ts, options, vueOptions, id => id),
    { getLanguageId: resolveFileLanguageId }
  ], new Map(), file => {
    const snapshot = read(file)?.snapshot
    if (snapshot) {
      language.scripts.set(file, snapshot)
    } else {
      language.scripts.delete(file)
    }
  })
  const resolutionCaches = []
  decorateLanguageServiceHost({
    ...ts,
    createModuleResolutionCache(...args) {
      const cache = ts.createModuleResolutionCache(...args)
      resolutionCaches.push(cache)
      return cache
    }
  }, language, host)
  const raw = ts.createLanguageService(host, ts.createDocumentRegistry())
  const adapter = createProxyLanguageService(raw)
  adapter.initialize(language)
  const service = adapter.proxy
  function generatedNode(file, offset) {
    const source = language.scripts.get(file)
    const script = source?.generated?.languagePlugin.typescript?.getServiceScript(source.generated.root)
    let at = offset
    if (script) {
      const mapping = language.maps.get(script.code, source)
      const location = mapping.toGeneratedLocation(offset, vue.isRenameEnabled).next().value
      if (!location) {
        return undefined
      }
      at = location[0] + (script.preventLeadingOffset ? 0 : source.snapshot.getLength())
    }
    const sourceFile = raw.getProgram()?.getSourceFile(file)
    return sourceFile ? ts.getTokenAtPosition(sourceFile, at) : undefined
  }
  function checkRenameConflicts(locations, name) {
    const program = raw.getProgram()
    const checker = program?.getTypeChecker()
    if (!checker) {
      throw new Error('类型程序尚未就绪，请稍后重新命名。')
    }
    for (const entry of locations) {
      const node = generatedNode(entry.fileName, entry.textSpan.start)
      if (!node || node.text === name) {
        continue
      }
      let existing
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        existing = checker.getPropertyOfType(checker.getTypeAtLocation(parent.expression), name)
      } else if (parent.name === node && (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent))) {
        existing = checker.getPropertyOfType(checker.getTypeAtLocation(parent.parent), name)
      } else {
        existing = checker.getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias)
          .find(symbol => symbol.name === name)
      }
      if (existing) {
        throw new Error(`“${name}”已经存在于引用所在的作用域或对象中；此次重命名会产生冲突。`)
      }
    }
  }
  const indexes = new Map()
  let moduleResolver = createModuleResolver({ workspaceRoot: configRoot })
  async function loadIndex(file, registryOnly = false) {
    file = normalize(file)
    const entry = read(file)
    if (!entry) {
      return null
    }
    if (registryOnly && !/\b(?:component|prototype|Store)\b/.test(entry.snapshot.getText(0, entry.snapshot.getLength()))) {
      return null
    }
    let cached = indexes.get(file)
    if (!cached || cached.version !== entry.version) {
      cached = { version: entry.version, index: buildIndex(entry.snapshot.getText(0, entry.snapshot.getLength()),
        file.endsWith('.vue') ? 'vue' : /\.(?:ts|tsx)$/.test(file) ? 'typescript' : 'javascript', file) }
    }
    indexes.delete(file)
    indexes.set(file, cached)
    while (indexes.size > 128) {
      indexes.delete(indexes.keys().next().value)
    }
    return cached.index
  }
  const indirect = createIndirectService(
    () => [...new Set([...projectFiles, ...buffers.keys()])].filter(file => !file.endsWith('.vue') && !file.endsWith('.d.ts')),
    loadIndex, (specifier, from) => moduleResolver(specifier, from))
  const libraryData = require('./library-data').createLibraryData(configRoot)
  let metadataVersion
  const metadataCache = new Map()

  async function componentMetadata(index, tag) {
    if (metadataVersion !== projectVersion) {
      metadataCache.clear()
      metadataVersion = projectVersion
    }
    const key = `${index.fileName}:${tag}`
    let result = metadataCache.get(key)
    if (!result) {
      result = (async () => {
        const component = await require('./component-info').componentInfo(index, tag, {
          loadIndex, resolveModule: moduleResolver
        }) || await indirect.componentInfo(index, tag)
        if (component) {
          return component
        }
        const { kebab } = require('./component-info')
        const components = libraryData.components()
        return components.find(component => component.name === tag) ||
          components.find(component => kebab(component.name) === kebab(tag)) || null
      })()
      metadataCache.set(key, result)
      while (metadataCache.size > 64) {
        metadataCache.delete(metadataCache.keys().next().value)
      }
      result.catch(() => {
        if (metadataCache.get(key) === result) {
          metadataCache.delete(key)
        }
      })
    }
    return result
  }

  function sync(documents) {
    const previousVersion = projectVersion
    const active = new Set()
    for (const document of documents) {
      const file = normalize(document.fileName)
      active.add(file)
      const previous = buffers.get(file)
      if (!previous || previous.sourceVersion !== String(document.version) || document.text !== undefined) {
        if (document.text === undefined) {
          throw new Error('Missing initial document snapshot: ' + file)
        }
        buffers.set(file, { sourceVersion: String(document.version), version: String(++projectVersion),
          snapshot: ts.ScriptSnapshot.fromString(document.text) })
        if (!file.endsWith('.vue')) {
          indirect.invalidate(file)
        }
      }
      if (file.startsWith(root + '/')) {
        if (!roots.has(file)) {
          roots.add(file)
          if (file.endsWith('.vue')) {
            componentFiles = new Set(componentFiles).add(file)
          }
        }
      }
    }
    for (const file of buffers.keys()) {
      if (!active.has(file)) {
        buffers.delete(file)
        projectVersion++
        if (!file.endsWith('.vue')) {
          indirect.invalidate(file)
        }
      }
    }
    // Filesystem notifications and buffer revisions invalidate the project.
    // Repeated queries against unchanged text reuse TypeScript's program.
    if (previousVersion !== projectVersion) moduleResolver = createModuleResolver({ workspaceRoot: configRoot })
  }
  function documentation(info) {
    return {
      text: parts(info?.displayParts), documentation: parts(info?.documentation),
      tags: info?.tags?.map(tag => ({ name: tag.name, text: typeof tag.text === 'string' ? tag.text : parts(tag.text) })) || []
    }
  }
  function diagnostic(entry) {
    return {
      start: entry.start || 0, length: entry.length || 0, code: entry.code,
      category: entry.category, message: ts.flattenDiagnosticMessageText(entry.messageText, '\n')
    }
  }
  return {
    sync,
    invalidate(file, kind) {
      file = normalize(file)
      projectVersion++
      if (!file.endsWith('.vue')) indirect.invalidate(file)
      moduleResolver = createModuleResolver({ workspaceRoot: configRoot })
      if (libraryData.affected(file)) {
        libraryData.invalidate()
      }
      disk.delete(file)
      indexes.delete(file)
      if (kind === 'create' || kind === 'delete') {
        for (const cache of resolutionCaches) {
          cache.clear()
        }
        raw.cleanupSemanticCache()
      }
      if (kind === 'delete') {
        roots.delete(file)
        if (file.endsWith('.vue')) {
          const next = new Set(componentFiles)
          next.delete(file)
          componentFiles = next
        }
        projectFiles = projectFiles.filter(value => value !== file)
      } else if (kind === 'create' && !projectFilesHost.ignored(file) && /\.(vue|[cm]?[jt]sx?)$/.test(file)) {
        roots.add(file)
        if (file.endsWith('.vue')) {
          componentFiles = new Set(componentFiles).add(file)
        }
        if (!projectFiles.includes(file)) {
          projectFiles.push(file)
        }
      }
    },
    async run(method, file, offset, args = {}) {
      file = normalize(file)
      if (method === 'slotCompletions') {
        const index = await loadIndex(file)
        const context = index && require('./slots').slotContext(index, offset)
        if (!context) {
          return []
        }
        const info = await componentMetadata(index, context.tag)
        const slots = info?.slots || []
        const entries = context.kind === 'slot' ? slots : slots.find(slot => slot.name === context.slotName)?.props || []
        return entries.filter(entry => !(context.used || []).includes(entry.name)).map(entry => ({
          name: entry.name, kind: 'property', documentation: entry.documentation,
          detail: context.kind === 'slot' ? `Vue slot (${entry.name})` : `Slot ${context.slotName}: ${entry.name}: ${entry.type || 'unknown'}`,
          replacementSpan: { start: context.start, length: context.end - context.start }
        }))
      }
      if (method === 'createTemplateMethod') {
        const index = await loadIndex(file)
        const result = index && require('./template-methods').templateMethod(index, offset, args)
        if (!result || service.getDefinitionAtPosition(file, offset)?.length) {
          return null
        }
        const inherited = await indirect.completions(index, offset)
        return inherited.some(entry => entry.name === result.name) ? null : result.changes
      }
      if (method === 'templateCompletions') {
        const index = await loadIndex(file)
        if (!index) {
          return []
        }
        const { templateContext, metadataCompletions } = require('./template-editing')
        const context = templateContext(index, offset)
        if (!context) {
          return []
        }
        if (context.kind === 'tag') {
          const prefix = context.prefix.toLowerCase()
          return [
            ...await require('./component-imports').componentCandidates(index, componentFiles, context.prefix,
              (specifier, from) => moduleResolver(specifier, from), projectVersion),
            ...libraryData.components().filter(component => component.name.toLowerCase().startsWith(prefix) ||
              component.name.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase().startsWith(prefix))
              .map(component => ({ name: component.name, kind: 'class',
              documentation: component.documentation, detail: component.source || 'Workspace component' }))
          ].map(entry => ({ ...entry, replacementSpan: { start: context.start, length: context.end - context.start } }))
        }
        return metadataCompletions(index, offset, await componentMetadata(index, context.tag), context)
      }
      if (method === 'componentHover') {
        const index = await loadIndex(file)
        const reference = index?.templateReferences.find(reference => offset >= reference.start && offset < reference.end)
        return reference ? require('./template-editing').metadataHover(index, offset, await componentMetadata(index, reference.tag)) : null
      }
      if (method === 'highlights') {
        return (service.getDocumentHighlights(file, offset, [file]) || []).flatMap(group => group.highlightSpans)
          .map(value => ({ ...value.textSpan, kind: value.kind }))
      }
      if (method === 'organizeImports') {
        return service.organizeImports({ type: 'file', fileName: file, mode: args.mode || 'All' },
          { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: '\n' }, {})
      }
      if (method === 'codeFixes') {
        const errors = args.codes || []
        return service.getCodeFixesAtPosition(file, offset, args.end ?? offset, errors,
          { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: '\n' },
          { importModuleSpecifierPreference: 'relative' }).filter(fix => fix.fixName === 'import' || fix.fixName === 'unusedIdentifier')
          .map(fix => ({ title: fix.description, changes: fix.changes }))
      }
      if (method === 'stats') {
        return { rootFiles: roots.size, loadedSnapshots: disk.size,
          heapUsed: process.memoryUsage().heapUsed, external: process.memoryUsage().external }
      }
      if (method === 'indirectDefinitions' || method === 'indirectCompletion') {
        const index = await loadIndex(file)
        return index ? indirect[method === 'indirectDefinitions' ? 'definitions' : 'completions'](index, offset) : []
      }
      if (method === 'quickInfo') {
        const info = service.getQuickInfoAtPosition(file, offset)
        return info ? { ...documentation(info), span: info.textSpan } : null
      }
      if (method === 'signature') {
        const info = service.getSignatureHelpItems(file, offset, undefined)
        return info ? {
          selected: info.selectedItemIndex, argument: info.argumentIndex,
          items: info.items.map(item => ({
            prefix: parts(item.prefixDisplayParts), suffix: parts(item.suffixDisplayParts),
            separator: parts(item.separatorDisplayParts), documentation: parts(item.documentation),
            parameters: item.parameters.map(parameter => ({ label: parts(parameter.displayParts), documentation: parts(parameter.documentation) }))
          }))
        } : null
      }
      if (method === 'definitions') {
        return service.getDefinitionAtPosition(file, offset) || []
      }
      if (method === 'references') {
        return (service.findReferences(file, offset) || []).flatMap(group => group.references)
          .filter(entry => args.includeDeclaration || !entry.isDefinition)
      }
      if (method === 'renameInfo') {
        return service.getRenameInfo(file, offset, { allowRenameOfImportPath: false })
      }
      if (method === 'rename') {
        const info = service.getRenameInfo(file, offset, { allowRenameOfImportPath: false })
        const nameProbe = ts.createSourceFile('rename.ts', `let ${args.name} = 0`, ts.ScriptTarget.Latest, true)
        const keyword = ts.stringToToken(args.name)
        const reserved = keyword >= ts.SyntaxKind.FirstKeyword && keyword <= ts.SyntaxKind.LastFutureReservedWord
        if (!info.canRename || !/^[$\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(args.name) ||
          reserved || ['await', 'eval', 'arguments'].includes(args.name) || nameProbe.parseDiagnostics.length) {
          throw new Error(info.localizedErrorMessage || '请输入有效的标识符名称。')
        }
        const locations = service.findRenameLocations(file, offset, false, false, true) || []
        if (!locations.length || locations.some(entry => /(?:^|\/)node_modules\//.test(entry.fileName))) {
          throw new Error('此符号没有可安全编辑的项目内引用。')
        }
        checkRenameConflicts(locations, args.name)
        return locations.map(entry => {
          const snapshot = read(entry.fileName)?.snapshot
          const expectedText = snapshot?.getText(entry.textSpan.start, entry.textSpan.start + entry.textSpan.length)
          return { ...entry, expectedText,
            newName: expectedText?.includes('-') ? args.name.replace(/\B([A-Z])/g, '-$1').toLowerCase() : args.name }
        })
      }
      if (method === 'completion') {
        const result = service.getCompletionsAtPosition(file, offset, {
          includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true,
          includeCompletionsWithSnippetText: true, includeAutomaticOptionalChainCompletions: true
        })
        return result ? {
          isIncomplete: result.isIncomplete,
          entries: result.entries.filter(entry => !entry.name.startsWith('__VLS_'))
        } : null
      }
      if (method === 'completionDetails') {
        const detail = service.getCompletionEntryDetails(file, offset, args.name,
          { indentSize: 2, tabSize: 2, newLineCharacter: '\n', convertTabsToSpaces: true },
          args.source, { importModuleSpecifierPreference: 'relative', includeCompletionsForModuleExports: true }, args.data)
        return detail ? { ...documentation(detail), actions: detail.codeActions || [] } : null
      }
      if (method === 'diagnostics') {
        return {
          entries: [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map(diagnostic),
          config: configErrors.filter(entry => entry.code !== 18003).map(diagnostic)
        }
      }
      throw new Error(`Unknown language request: ${method}`)
    },
    files: () => [...roots].filter(file => file !== typesFile),
    configuration: () => [...configuration].map(([fileName, stamp]) => ({ fileName, stamp })),
    dispose: () => { service.dispose(); indirect.dispose(); disk.clear(); buffers.clear(); indexes.clear(); metadataCache.clear() }
  }
}

module.exports = { createProjectService }
