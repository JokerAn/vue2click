'use strict'

// Load the actual shipped entry as CommonJS. The host normally supplies vscode;
// the stub makes activation failures detectable during every build/package.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.notEqual(manifest.type, 'module', 'the extension host entry must use CommonJS')
const main = path.resolve(root, manifest.main)
const code = fs.readFileSync(main, 'utf8')
let vscodeLoads = 0
const registrations = []
const disposable = () => ({ dispose() {} })
const host = {
  window: { onDidChangeActiveTextEditor: disposable },
  languages: {
    registerDefinitionProvider(selector, provider) {
      assert.equal(typeof provider.provideDefinition, 'function')
      registrations.push('definition')
      return disposable()
    },
    registerCompletionItemProvider(selector, provider) {
      assert.equal(typeof provider.provideCompletionItems, 'function')
      registrations.push('completion')
      return disposable()
    },
    ...Object.fromEntries([
      'DocumentSymbol', 'Hover', 'SignatureHelp', 'Reference', 'Rename',
      'DocumentFormattingEdit', 'Color', 'LinkedEditingRange',
      'DocumentLink', 'DocumentHighlight', 'FoldingRange', 'SelectionRange'
    ].map(name => [`register${name}Provider`, () => { registrations.push(name); return disposable() }])),
    createDiagnosticCollection: () => ({ ...disposable(), delete() {} })
  },
  workspace: {
    textDocuments: [],
    onDidOpenTextDocument: disposable,
    onDidChangeTextDocument: disposable,
    onDidChangeConfiguration: disposable,
    onDidCloseTextDocument() {
      registrations.push('close')
      return disposable()
    }
  }
}
const entry = new Module(main, module)
entry.filename = main
entry.paths = Module._nodeModulePaths(path.dirname(main))
entry.require = function(specifier) {
  if (specifier === 'vscode') {
    vscodeLoads++
    return host
  }
  return Module.prototype.require.call(this, specifier)
}
entry._compile(code, main)
assert.equal(vscodeLoads, 1, 'vscode must load through the CommonJS host require')
assert.equal(typeof entry.exports.activate, 'function')
assert.equal(typeof entry.exports.deactivate, 'function')
const context = { subscriptions: [] }
entry.exports.activate(context)
assert.deepEqual(registrations.sort(), [
  'DocumentSymbol', 'Hover', 'SignatureHelp', 'Reference', 'Rename',
  'DocumentFormattingEdit', 'Color', 'LinkedEditingRange',
  'DocumentLink', 'DocumentHighlight', 'FoldingRange', 'SelectionRange',
  'close', 'close', 'completion', 'completion', 'definition'
].sort())
for (const subscription of context.subscriptions) {
  subscription.dispose()
}
entry.exports.deactivate()
console.log('Bundled CommonJS entry loads and registers all editing providers.')
