'use strict'

const css = require('vscode-css-languageservice')
const { TextDocument } = require('vscode-languageserver-textdocument')
const { createResourceResolver, resourceReferences, localReference } = require('./resource-paths')

const languages = { css: css.getCSSLanguageService(), scss: css.getSCSSLanguageService(), less: css.getLESSLanguageService() }

function createStyleResources() {
  const cache = new Map()
  let characters = 0
  function remove(key) {
    characters -= cache.get(key)?.length || 0
    cache.delete(key)
  }
  function references(document) {
    const key = document.uri.toString()
    let entry = cache.get(key)
    if (entry?.document === document && entry.version === document.version && entry.language === document.languageId) {
      cache.delete(key)
      cache.set(key, entry)
      return entry.references
    }
    remove(key)
    const language = languages[document.languageId]
    if (!language) return []
    const text = document.getText()
    const source = TextDocument.create(key, document.languageId, document.version, text)
    const parsed = language.parseStylesheet(source)
    const index = { text, blocks: [] }
    const values = resourceReferences(index, [{
      language: document.languageId, service: language, document: source, parsed, block: { start: 0, end: text.length }
    }]).filter(value => (value.reference === '' || localReference(value.reference)) &&
      !/[$(){}]/.test(value.reference) &&
      !(value.reference.startsWith('@') && !value.reference.includes('/')))
      .sort((a, b) => a.start - b.start)
    // Walk statement boundaries once. Strings and comments may contain both
    // semicolons and "@import"; neither should change the surrounding statement.
    const tokens = text.matchAll(/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[;{}]|@import\b/gi)
    let token = tokens.next()
    let importing = false
    for (const value of values) {
      while (!token.done && token.value.index <= value.start) {
        const word = token.value[0]
        if (/^@import$/i.test(word)) importing = true
        else if (/^[;{}]$/.test(word)) importing = false
        token = tokens.next()
      }
      value.kind = importing ? 'import' : 'url'
    }
    entry = { document, language: document.languageId, version: document.version, length: text.length, references: values }
    cache.set(key, entry)
    characters += entry.length
    while (cache.size > 16 || characters > 2_000_000) remove(cache.keys().next().value)
    return values
  }
  function request(document, options) {
    const version = document.version
    const isCancelled = () => Boolean(document.isClosed || document.version !== version || options.isCancelled?.())
    return { isCancelled, resolver: createResourceResolver({ ...options, isCancelled }) }
  }
  async function resolve(document, reference, options = {}) {
    if (!reference.closed || !reference.reference || reference.reference.endsWith('/')) return null
    const { resolver, isCancelled } = request(document, options)
    if (isCancelled()) return null
    return reference.kind === 'import'
      ? resolver.resolveStylesheet(reference.reference, document.fileName, document.languageId)
      : resolver.resolve(reference.reference, document.fileName)
  }
  return {
    references,
    resolve,
    async definition(document, offset, options = {}) {
      const reference = references(document).find(value => offset >= value.start && offset < value.end)
      return reference ? resolve(document, reference, options) : null
    },
    async complete(document, offset, options = {}) {
      const reference = references(document).find(value => offset >= value.start && offset <= value.end)
      if (!reference) return { items: [] }
      const text = document.getText()
      const before = text.slice(reference.start, offset)
      const slash = before.lastIndexOf('/')
      const next = text.indexOf('/', offset)
      const start = reference.start + slash + 1
      const end = reference.closed ? next >= offset && next < reference.end ? next : reference.end : offset
      const { resolver, isCancelled } = request(document, options)
      if (isCancelled()) return { items: [] }
      const result = await resolver.completePaths(before, document.fileName)
      return isCancelled() ? { items: [] } : {
        start, end,
        items: result.items.filter(item => reference.kind !== 'import' || item.kind === 'folder' || /\.(css|scss|less)$/i.test(item.name))
      }
    },
    close: document => remove(document.uri.toString()),
    dispose() { cache.clear(); characters = 0 }
  }
}

function registerStyleResources(vscode, context) {
  const resources = createStyleResources()
  const selector = ['css', 'scss', 'less'].map(language => ({ language, scheme: 'file' }))
  const enabled = (document, key) => vscode.workspace.getConfiguration('vueClick', document.uri).get(key, true)
  const current = (document, version, token) => !document.isClosed && document.version === version && !token?.isCancellationRequested
  const options = (document, version, token) => ({
    workspaceRoot: vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath,
    isCancelled: () => !current(document, version, token)
  })
  context.subscriptions.push(resources,
    vscode.workspace.onDidCloseTextDocument(document => resources.close(document)),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        if (!enabled(document, 'definition.enabled') || token?.isCancellationRequested) return undefined
        const version = document.version
        const target = await resources.definition(document, document.offsetAt(position), options(document, version, token))
        return target && current(document, version, token)
          ? new vscode.Location(vscode.Uri.file(target), new vscode.Range(document.positionAt(0), document.positionAt(0))) : undefined
      }
    }),
    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks(document, token) {
        if (!enabled(document, 'definition.enabled') || token?.isCancellationRequested) return []
        return resources.references(document).filter(reference =>
          reference.closed && reference.reference && !reference.reference.endsWith('/')).map(reference => {
          const link = new vscode.DocumentLink(new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end)))
          link.vueClickStyle = { document, version: document.version, reference }
          return link
        })
      },
      async resolveDocumentLink(link, token) {
        const value = link.vueClickStyle
        if (!value || !current(value.document, value.version, token) || !enabled(value.document, 'definition.enabled')) return link
        const target = await resources.resolve(value.document, value.reference, options(value.document, value.version, token))
        if (target && current(value.document, value.version, token)) link.target = vscode.Uri.file(target)
        return link
      }
    }),
    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(document, position, token) {
        if (!enabled(document, 'completion.enabled') || token?.isCancellationRequested) return undefined
        const version = document.version
        const result = await resources.complete(document, document.offsetAt(position), options(document, version, token))
        if (!result.items.length || !current(document, version, token)) return undefined
        return result.items.map(value => {
          const item = new vscode.CompletionItem(value.name,
            value.kind === 'folder' ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File)
          item.detail = 'VueClick style resource'
          item.range = new vscode.Range(document.positionAt(result.start), document.positionAt(result.end))
          item.insertText = value.kind === 'folder' && document.getText().charAt(result.end) === '/'
            ? value.name.slice(0, -1) : value.name
          if (value.kind === 'folder') item.command = { command: 'editor.action.triggerSuggest', title: 'Continue style path' }
          return item
        })
      }
    }, '/', '"', "'"))
}

module.exports = { createStyleResources, registerStyleResources }
