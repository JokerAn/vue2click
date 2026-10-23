'use strict'

const vscode = require('vscode')
const { buildIndex, findDefinition } = require('./resolver')
const { findComponentDefinition, componentProps } = require('./components')
const { createModuleResolver } = require('./module-paths')
const { completionContext } = require('./completion')
const { findImportedDefinition } = require('./imports')
const { registerAdvanced } = require('./advanced')

function activate(context) {
  const cache = new Map()
  let cachedCharacters = 0
  const maxCachedDocuments = 32
  const maxCachedCharacters = 4_000_000
  const pendingModules = new Map()
  const pendingDocuments = new Map()
  const selector = ['vue', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact']
    .map(language => ({ scheme: 'file', language }))

  function removeIndex(key) {
    const entry = cache.get(key)
    if (entry) cachedCharacters -= entry.index.source.length
    cache.delete(key)
  }

  // Share only work that is currently in progress. Completed path resolutions
  // are discarded so config edits, new files and removals are visible next time.
  function pending(map, key, load) {
    if (!map.has(key)) {
      const promise = Promise.resolve().then(load).finally(() => { map.delete(key) })
      map.set(key, promise)
    }
    return map.get(key)
  }

  function documentIndex(document) {
    const key = document.uri.toString()
    let entry = cache.get(key)
    if (!entry || entry.version !== document.version) {
      removeIndex(key)
      entry = { version: document.version, index: buildIndex(document.getText(), document.languageId, document.fileName) }
      cachedCharacters += entry.index.source.length
    }
    // Refresh recency and keep both document count and retained source bounded.
    cache.delete(key)
    cache.set(key, entry)
    while (cache.size > maxCachedDocuments || cachedCharacters > maxCachedCharacters) removeIndex(cache.keys().next().value)
    return entry.index
  }

  function requestContext(document, token, index) {
    const snapshots = new Map([[document, document.version]])
    const isCancelled = () => {
      if (token?.isCancellationRequested) {
        return true
      }
      for (const [source, version] of snapshots) {
        if (source.version !== version) {
          return true
        }
      }
      return false
    }
    const workspaceRoot = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath
    const resolve = createModuleResolver({ workspaceRoot })
    const documents = new Map([[document.fileName, document]])
    const loadedIndexes = new Map([[document.fileName, Promise.resolve(index)]])
    const resolvedModules = new Map()
    return {
      documents, isCancelled,
      resolveModule(specifier, fromFile) {
        const key = JSON.stringify([workspaceRoot, fromFile, specifier])
        if (!resolvedModules.has(key)) {
          resolvedModules.set(key, pending(pendingModules, key, () => resolve(specifier, fromFile)))
        }
        return resolvedModules.get(key)
      },
      async loadIndex(fileName) {
        if (isCancelled()) {
          return null
        }
        if (!loadedIndexes.has(fileName)) {
          loadedIndexes.set(fileName, (async () => {
            const child = await pending(pendingDocuments, fileName,
              () => vscode.workspace.openTextDocument(vscode.Uri.file(fileName)))
            if (isCancelled()) {
              return null
            }
            documents.set(fileName, child)
            snapshots.set(child, child.version)
            return documentIndex(child)
          })())
        }
        return loadedIndexes.get(fileName)
      }
    }
  }

  async function resolveStatic(document, position, token) {
    const index = documentIndex(document)
    const request = requestContext(document, token, index)
    const offset = document.offsetAt(position)
    const hit = findDefinition(index, offset) ||
      await findImportedDefinition(index, offset, request) ||
      await findComponentDefinition(index, offset, request)
    if (request.isCancelled()) {
      return { stale: true }
    }
    if (!hit) {
      return undefined
    }
    const target = hit.fileName ? request.documents.get(hit.fileName) : document
    return target ? { ...hit, document: target, index: documentIndex(target) } : undefined
  }

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position, token) {
      try {
        if (token?.isCancellationRequested) {
          return undefined
        }
        if (!vscode.workspace.getConfiguration('vueClick', document.uri).get('definition.enabled', true)) {
          return undefined
        }
        const hit = await resolveStatic(document, position, token)
        if (hit?.stale || token?.isCancellationRequested) {
          return undefined
        }
        if (!hit) {
          const result = await advanced.definitions(document, position, token)
          return result?.length ? result : undefined
        }
        return new vscode.Location(hit.document.uri, new vscode.Range(
          hit.document.positionAt(hit.start), hit.document.positionAt(hit.end)
        ))
      } catch (error) {
        console.error('[Vue2Click] Definition lookup failed:', error)
        return undefined
      }
    }
  }))
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    [{ scheme: 'file', language: 'vue' }, { scheme: 'untitled', language: 'vue' }], {
      async provideCompletionItems(document, position, token) {
        if (token?.isCancellationRequested) {
          return undefined
        }
        try {
          const config = vscode.workspace.getConfiguration('vueClick', document.uri)
          const settings = {
            members: config.get('completion.enabled', true),
            snippets: config.get('snippets.enabled', true)
          }
          if (!settings.members && !settings.snippets) {
            return undefined
          }
          const index = documentIndex(document)
          const request = requestContext(document, token, index)
          const result = completionContext(index, index.text, document.offsetAt(position), settings)
          if (result.props && document.uri.scheme !== 'untitled') {
            const props = await componentProps(index, result.props.tag, request)
            for (const name of props) {
              const kebab = name.replace(/\B([A-Z])/g, '-$1').toLowerCase()
              if (!result.props.used.has(name) && !result.props.used.has(kebab)) {
                result.items.push({
                  name: kebab, kind: 'property', detail: `Vue prop (${name})`,
                  start: result.props.start, end: result.props.end
                })
              }
            }
          }
          if (request.isCancelled()) {
            return undefined
          }
          return result.items.map(entry => {
            const kinds = { method: 'Method', property: 'Property', variable: 'Variable', class: 'Class', snippet: 'Snippet' }
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind[kinds[entry.kind]])
            item.detail = entry.detail
            item.range = new vscode.Range(document.positionAt(entry.start), document.positionAt(entry.end))
            item.insertText = entry.kind === 'snippet' ? new vscode.SnippetString(entry.insertText) : entry.name
            item.filterText = entry.filterText || entry.name
            return item
          })
        } catch (error) {
          console.error('[Vue2Click] Completion failed:', error)
          return undefined
        }
      }
    }, '.', '<', ':', '@', '"', "'"
  ))
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    removeIndex(document.uri.toString())
  }))
  const advanced = registerAdvanced(vscode, context, documentIndex, resolveStatic)
}

function deactivate() {}

module.exports = { activate, deactivate }
