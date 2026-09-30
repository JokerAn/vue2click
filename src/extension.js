'use strict'

const vscode = require('vscode')
const { buildIndex, findDefinition } = require('./resolver')

function activate(context) {
  const cache = new Map()
  const selector = ['vue', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact']
    .map(language => ({ scheme: 'file', language }))

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition(document, position) {
      try {
        const key = document.uri.toString()
        let entry = cache.get(key)
        if (!entry || entry.version !== document.version) {
          entry = { version: document.version, index: buildIndex(document.getText(), document.languageId, document.fileName) }
          cache.set(key, entry)
        }
        const start = document.offsetAt(position)
        const hit = findDefinition(entry.index, start)
        if (!hit) return undefined // Leave external/imported symbols to other providers.
        return new vscode.Location(document.uri, new vscode.Range(
          document.positionAt(hit.start), document.positionAt(hit.end)
        ))
      } catch (error) {
        console.error('[Vue2Click] Definition lookup failed:', error)
        return undefined
      }
    }
  }))
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    cache.delete(document.uri.toString())
  }))
}

function deactivate() {}

module.exports = { activate, deactivate }
