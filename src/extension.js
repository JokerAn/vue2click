'use strict'

const vscode = require('vscode')
const { buildIndex, findDefinition } = require('./resolver')
const { findComponentDefinition } = require('./components')
const { createModuleResolver } = require('./module-paths')

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

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position, token) {
      try {
        const version = document.version
        const snapshots = new Map([[document, version]])
        const isCancelled = () => {
          if (token?.isCancellationRequested) return true
          for (const [source, sourceVersion] of snapshots) if (source.version !== sourceVersion) return true
          return false
        }
        if (isCancelled()) return undefined
        const index = documentIndex(document)
        const start = document.offsetAt(position)
        let targetDocument = document
        let hit = findDefinition(index, start)
        if (!hit) {
          const workspaceRoot = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath
          const resolve = createModuleResolver({ workspaceRoot })
          const documents = new Map([[document.fileName, document]])
          const loadedIndexes = new Map([[document.fileName, Promise.resolve(index)]])
          const resolvedModules = new Map()
          hit = await findComponentDefinition(index, start, {
            isCancelled,
            resolveModule(specifier, fromFile) {
              const key = JSON.stringify([workspaceRoot, fromFile, specifier])
              if (!resolvedModules.has(key)) resolvedModules.set(key, pending(pendingModules, key,
                () => resolve(specifier, fromFile)))
              return resolvedModules.get(key)
            },
            async loadIndex(fileName) {
              if (isCancelled()) return null
              if (!loadedIndexes.has(fileName)) loadedIndexes.set(fileName, (async () => {
                const child = await pending(pendingDocuments, fileName,
                  () => vscode.workspace.openTextDocument(vscode.Uri.file(fileName)))
                if (isCancelled()) return null
                documents.set(fileName, child)
                snapshots.set(child, child.version)
                return documentIndex(child)
              })())
              return loadedIndexes.get(fileName)
            }
          })
          if (hit) targetDocument = documents.get(hit.fileName)
        }
        if (!hit) return undefined // Leave external/imported symbols to other providers.
        if (isCancelled() || !targetDocument) return undefined
        return new vscode.Location(targetDocument.uri, new vscode.Range(
          targetDocument.positionAt(hit.start), targetDocument.positionAt(hit.end)
        ))
      } catch (error) {
        console.error('[Vue2Click] Definition lookup failed:', error)
        return undefined
      }
    }
  }))
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    removeIndex(document.uri.toString())
  }))
}

function deactivate() {}

module.exports = { activate, deactivate }
