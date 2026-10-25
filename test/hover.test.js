'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { TextDocument } = require('vscode-languageserver-textdocument')
const { buildIndex, findDefinition } = require('../src/resolver')

class Range {
  constructor(start, end) { this.start = start; this.end = end }
}

function document(text, file = '/app/Page.vue') {
  const source = TextDocument.create('file://' + file, file.endsWith('.vue') ? 'vue' : 'javascript', 1, text)
  const value = {
    version: 1, fileName: file, languageId: source.languageId, isClosed: false,
    uri: { scheme: 'file', fsPath: file, toString: () => source.uri },
    offsetAt: position => source.offsetAt(position),
    positionAt: offset => source.positionAt(offset),
    getText: range => source.getText(range),
    getWordRangeAtPosition(position) {
      const at = source.offsetAt(position)
      for (const match of text.matchAll(/[$\w]+/g)) {
        if (at >= match.index && at < match.index + match[0].length) {
          return new Range(source.positionAt(match.index), source.positionAt(match.index + match[0].length))
        }
      }
    }
  }
  value.index = buildIndex(text, value.languageId, file)
  return value
}

function harness(t, resolve, answers = {}) {
  const providers = {}
  const requests = []
  const disposable = () => ({ dispose() {} })
  const client = {
    request: async method => { requests.push(method); return answers[method] || null },
    dispose() {}, close() {}, invalidate() {}, configDocumentChanged() {}
  }
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) },
    Range,
    MarkdownString: class {
      constructor(value = '') { this.value = value }
      appendCodeblock(value) { this.value += '\n' + value; return this }
      appendMarkdown(value) { this.value += value; return this }
    },
    Hover: class {
      constructor(contents, range) { this.contents = contents; this.range = range }
    },
    CodeActionKind: { QuickFix: {}, SourceOrganizeImports: {}, Source: { append: () => ({}) } },
    commands: { registerCommand: disposable },
    window: { onDidChangeActiveTextEditor: disposable, onDidChangeTextEditorSelection: disposable },
    languages: new Proxy({
      createDiagnosticCollection: () => ({ dispose() {}, delete() {} })
    }, {
      get(target, name) {
        return target[name] || ((selector, provider) => { providers[name] = provider; return disposable() })
      }
    }),
    workspace: {
      textDocuments: [],
      openTextDocument: async uri => answers.documents.get(uri.fsPath),
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
      onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable, onDidChangeConfiguration: disposable, onDidSaveTextDocument: disposable
    }
  }
  const file = require.resolve('../src/advanced')
  const previous = require.cache[file]
  const load = Module._load
  let registerAdvanced
  try {
    delete require.cache[file]
    Module._load = function (name, parent, ...args) {
      if (parent?.filename === file && name === './language-client') return { createLanguageClient: () => client }
      return load.call(this, name, parent, ...args)
    }
    registerAdvanced = require(file).registerAdvanced
  } finally {
    Module._load = load
    delete require.cache[file]
    if (previous) require.cache[file] = previous
  }
  const context = { subscriptions: [] }
  registerAdvanced(vscode, context, doc => doc.index, resolve)
  t.after(() => context.subscriptions.forEach(value => value.dispose()))
  return { provider: providers.registerHoverProvider, requests }
}

test('documented import hover returns without worker requests and uses the reference range', async t => {
  const source = document('import { save } from "./helper";\n\nsave()', '/app/Page.js')
  const target = document('/** Save an invoice. */\nexport function save(value) {}', '/app/helper.js')
  const start = target.getText().indexOf('save(')
  const { provider, requests } = harness(t, async () => ({ index: target.index, document: target, start }))
  const at = source.positionAt(source.getText().lastIndexOf('save') + 1)
  const hover = await provider.provideHover(source, at, { isCancellationRequested: false })
  assert.match(hover.contents.value, /Save an invoice/)
  assert.deepEqual(requests, [])
  assert.equal(source.getText(hover.range), 'save', 'target declaration offsets must not be applied to the source document')
})

test('documented parameter hover preserves its JSDoc type without starting the worker', async t => {
  const source = document('<script>/**\n * @param {string} orderId Invoice identifier.\n */\nfunction save(orderId) { return orderId }\n</script>')
  const { provider, requests } = harness(t, async (doc, position) => {
    const hit = findDefinition(doc.index, doc.offsetAt(position))
    return hit && { ...hit, index: doc.index, document: doc }
  })
  const at = source.positionAt(source.getText().lastIndexOf('orderId') + 1)
  const hover = await provider.provideHover(source, at, { isCancellationRequested: false })
  assert.match(hover.contents.value, /orderId: string/)
  assert.match(hover.contents.value, /Invoice identifier/)
  assert.deepEqual(requests, [])
})

test('an edit while resolving a hover suppresses its result and worker fallback', async t => {
  const source = document('<script>/** Save. */ function save() {} save()</script>')
  const { provider, requests } = harness(t, async doc => { doc.version++; return undefined })
  const hover = await provider.provideHover(source, source.positionAt(source.getText().lastIndexOf('save') + 1),
    { isCancellationRequested: false })
  assert.equal(hover, undefined)
  assert.deepEqual(requests, [], 'an obsolete request must not start a new semantic query')
})

test('hover on a documented declaration does not resolve imports or query the worker', async t => {
  const source = document('/** Direct declaration. */\nfunction save() {}', '/app/Page.js')
  const { provider, requests } = harness(t, async () => { assert.fail('declaration hover must not resolve definitions') })
  const at = source.positionAt(source.getText().indexOf('save') + 1)
  const hover = await provider.provideHover(source, at, { isCancellationRequested: false })
  assert.match(hover.contents.value, /Direct declaration/)
  assert.equal(source.getText(hover.range), 'save')
  assert.deepEqual(requests, [])
})

test('a unique prototype registration shows its source even without JSDoc', async t => {
  const source = document('<script>export default { methods: { run() { this.$notify() } } }</script>')
  const plugin = document(`import Vue from 'vue'; Vue.prototype.$notify = () => {}`, '/app/plugin.js')
  const registration = { fileName: plugin.fileName, sourceKind: 'Vue.prototype',
    textSpan: { start: plugin.getText().indexOf('$notify'), length: '$notify'.length } }
  const { provider } = harness(t, async () => undefined, {
    indirectDefinitions: [registration], documents: new Map([[plugin.fileName, plugin]])
  })
  const hover = await provider.provideHover(source, source.positionAt(source.getText().indexOf('$notify') + 1),
    { isCancellationRequested: false })
  assert.match(hover?.contents.value || '', /Vue\.prototype.*plugin\.js/)
})

test('ambiguous indirect definitions do not borrow the first candidate documentation', async t => {
  const source = document('<script>export default { methods: { run() { this.$notify() } } }</script>')
  const plugin = document(`/** First candidate. */\nconst $notify = () => {}`, '/app/plugin.js')
  const definition = { fileName: plugin.fileName,
    textSpan: { start: plugin.getText().indexOf('$notify'), length: '$notify'.length } }
  const { provider } = harness(t, async () => undefined, {
    indirectDefinitions: [definition, { ...definition, fileName: '/app/other.js' }],
    documents: new Map([[plugin.fileName, plugin]])
  })
  const hover = await provider.provideHover(source, source.positionAt(source.getText().indexOf('$notify') + 1),
    { isCancellationRequested: false })
  assert.equal(hover, undefined)
})
