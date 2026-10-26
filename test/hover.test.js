'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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

function localResolve(doc, position) {
  const hit = findDefinition(doc.index, doc.offsetAt(position))
  return hit && { ...hit, index: doc.index, document: doc }
}

function harness(t, resolve, answers = {}) {
  const providers = {}
  const requests = []
  const watchers = []
  const fileChanges = []
  const registeredCommands = {}
  const diagnosticCollections = []
  const disposable = () => ({ dispose() {} })
  const client = {
    request: async method => { requests.push(method); return answers[method] || null },
    fileChanged: (...args) => fileChanges.push(args),
    dispose() {}, close() {}, invalidate() {}, configDocumentChanged() {}
  }
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) },
    Range,
    Position: class {
      constructor(line, character) { this.line = line; this.character = character }
    },
    WorkspaceEdit: class {
      constructor() { this.edits = [] }
      replace(uri, range, newText) { this.edits.push({ uri, range, newText }) }
    },
    Location: class {
      constructor(uri, range) { this.uri = uri; this.range = range }
    },
    MarkdownString: class {
      constructor(value = '') { this.value = value }
      appendCodeblock(value) { this.value += '\n' + value; return this }
      appendMarkdown(value) { this.value += value; return this }
    },
    Hover: class {
      constructor(contents, range) { this.contents = contents; this.range = range }
    },
    Diagnostic: class {
      constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: { QuickFix: {}, SourceOrganizeImports: {}, Source: { append: () => ({}) } },
    ProgressLocation: { Notification: 15 },
    commands: { registerCommand(name, run) { registeredCommands[name] = run; return disposable() } },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: disposable, onDidChangeTextEditorSelection: disposable,
      withProgress: (options, task) => task({ report() {} }, { isCancellationRequested: false }),
      showInformationMessage: () => Promise.resolve(undefined)
    },
    languages: new Proxy({
      createDiagnosticCollection: () => {
        const values = new Map()
        const collection = {
          values,
          set: (uri, list) => values.set(String(uri), list),
          delete: uri => values.delete(String(uri)),
          clear: () => values.clear(),
          dispose() {}
        }
        diagnosticCollections.push(collection)
        return collection
      }
    }, {
      get(target, name) {
        return target[name] || ((selector, provider) => { providers[name] = provider; return disposable() })
      }
    }),
    workspace: {
      textDocuments: [],
      openTextDocument: async uri => answers.openTextDocument ? answers.openTextDocument(uri) : answers.documents.get(uri.fsPath),
      createFileSystemWatcher(pattern) {
        const watcher = { pattern, dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }
        watchers.push(watcher)
        return watcher
      },
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
      onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable, onDidChangeConfiguration: disposable, onDidSaveTextDocument: disposable
    }
  }
  const file = require.resolve('../src/advanced')
  const previous = require.cache[file]
  const load = Module._load
  let registerAdvanced
  let clientOptions
  try {
    delete require.cache[file]
    Module._load = function (name, parent, ...args) {
      if (parent?.filename === file && name === './language-client') {
        return { createLanguageClient: (vscode, context, WorkerClass, options) => { clientOptions = options; return client } }
      }
      return load.call(this, name, parent, ...args)
    }
    registerAdvanced = require(file).registerAdvanced
  } finally {
    Module._load = load
    delete require.cache[file]
    if (previous) require.cache[file] = previous
  }
  const context = { subscriptions: [] }
  const advanced = registerAdvanced(vscode, context, doc => doc.index, resolve)
  t.after(() => context.subscriptions.forEach(value => value.dispose()))
  return { provider: providers.registerHoverProvider, references: providers.registerReferenceProvider,
    rename: providers.registerRenameProvider, advanced, requests, watchers, fileChanges, vscode,
    commands: registeredCommands, diagnostics: diagnosticCollections[0],
    start: () => clientOptions?.onStart?.() }
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

test('simple constant arrays show fixed values and the complete declaration-time map', async t => {
  const text = `const serviceOperateBtn = ['联系客服', '我要催单', null, , '已解决']
serviceOperateBtn[index]
serviceOperateBtn[1]`
  const source = document(text, '/app/Page.js')
  const { provider, requests } = harness(t, localResolve)
  const fixed = await provider.provideHover(source, source.positionAt(text.lastIndexOf('serviceOperateBtn') + 2),
    { isCancellationRequested: false })
  assert.match(fixed.contents.value, /serviceOperateBtn\[1\]/)
  assert.match(fixed.contents.value, /1 → "我要催单"/)
  assert.deepEqual(requests, [])

  const dynamic = await provider.provideHover(source, source.positionAt(text.indexOf('serviceOperateBtn[') + 2),
    { isCancellationRequested: false })
  assert.match(dynamic.contents.value, /声明时索引映射/)
  assert.match(dynamic.contents.value, /0 → "联系客服"/)
  assert.match(dynamic.contents.value, /2 → null/)
  assert.match(dynamic.contents.value, /3 → <空槽>/)
  assert.match(dynamic.contents.value, /4 → "已解决"/)
  assert.deepEqual(requests, [])
})

test('imported constant arrays work across ESM files and through a Vue data alias in templates', async t => {
  const imported = `import { serviceOperateBtn } from './constants'
export default { data() { return { serviceOperateBtn } }, methods: { run() { return serviceOperateBtn[status] } } }`
  const targetText = `export const serviceOperateBtn = ['联系客服', '我要催单', null]`
  const target = document(targetText, '/app/constants.js')
  const hit = { index: target.index, document: target, start: targetText.indexOf('serviceOperateBtn'),
    end: targetText.indexOf('serviceOperateBtn') + 'serviceOperateBtn'.length }
  const source = document(`<template>{{ serviceOperateBtn[0] }}</template>\n<script>\n${imported}\n</script>`)
  const shorthand = source.getText().lastIndexOf('{ serviceOperateBtn }') + '{ '.length
  const resolve = async (doc, position) => {
    const local = findDefinition(doc.index, doc.offsetAt(position))
    if (local) return { ...local, index: doc.index, document: doc }
    if (doc !== source) return undefined
    const offset = doc.offsetAt(position)
    const text = doc.getText()
    const length = 'serviceOperateBtn'.length
    return offset === shorthand || text.slice(offset, offset + length) === 'serviceOperateBtn' ||
      text.slice(offset - 1, offset - 1 + length) === 'serviceOperateBtn' ? hit : undefined
  }
  const { provider } = harness(t, resolve)
  const template = await provider.provideHover(source, source.positionAt(source.getText().indexOf('serviceOperateBtn[0]') + 1),
    { isCancellationRequested: false })
  assert.match(template.contents.value, /0 → "联系客服"/)

  const script = await provider.provideHover(source, source.positionAt(source.getText().lastIndexOf('serviceOperateBtn[') + 1),
    { isCancellationRequested: false })
  assert.match(script.contents.value, /声明时索引映射/)
  assert.match(script.contents.value, /2 → null/)
})

test('a uniquely passed constant array follows restricted same-file function parameters', async t => {
  const text = `const labels = ['未处理', '处理中', '已完成']
function getLabel(buttons) { return buttons[1] }
getLabel(labels)
getLabel(labels)`
  const source = document(text, '/app/Page.js')
  const { provider } = harness(t, localResolve)
  const hover = await provider.provideHover(source, source.positionAt(text.indexOf('buttons[1]') + 1),
    { isCancellationRequested: false })
  assert.match(hover.contents.value, /labels\[1\]/)
  assert.match(hover.contents.value, /1 → "处理中"/)
})

test('parameter inference declines different arrays, reassigned parameters and mutated arrays', async t => {
  for (const text of [
    `const first = ['a']; const second = ['b']
function getLabel(buttons) { return buttons[0] }
getLabel(first); getLabel(second)`,
    `const first = ['a']
function getLabel(buttons) { buttons = first; return buttons[0] }
getLabel(first)`,
    `const first = ['a']; first.push('b'); first[0]`
  ]) {
    const source = document(text, '/app/Page.js')
    const { provider } = harness(t, localResolve)
    const offset = text.lastIndexOf('buttons') >= 0 ? text.lastIndexOf('buttons') + 1 : text.lastIndexOf('first[') + 1
    const hover = await provider.provideHover(source, source.positionAt(offset), { isCancellationRequested: false })
    assert.equal(hover, undefined, text)
  }
})

test('complex or unmodelled arrays do not produce partial mappings', async t => {
  for (const expression of ["['a', condition ? 'b' : 'c']", "['a', ...others]", "['a', makeValue()]"]) {
    const text = `const values = ${expression}\nvalues[index]`
    const source = document(text, '/app/Page.js')
    const { provider } = harness(t, localResolve)
    assert.equal(await provider.provideHover(source, source.positionAt(text.lastIndexOf('values') + 1),
      { isCancellationRequested: false }), undefined, expression)
  }
})

test('the main source watcher covers every supported JavaScript and TypeScript extension', t => {
  const { watchers, start } = harness(t, async () => undefined)
  assert.deepEqual(watchers, [], 'activation must not install a workspace-wide watcher before semantics start')
  start()
  const pattern = watchers[0]?.pattern || ''
  for (const extension of ['vue', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json']) {
    assert.ok(pattern.includes(`*.${extension}`), extension)
  }
  start()
  assert.equal(watchers.length, 1, 'the watcher is created once per session')
})

test('semantic definitions and references discard edits made while opening their targets', async t => {
  for (const method of ['definitions', 'references']) {
    const source = document('save()', '/app/Page.js')
    const target = document('function save() {}', '/app/helper.js')
    const start = target.getText().indexOf('save')
    let notifyEntered
    let release
    const entered = new Promise(resolve => { notifyEntered = resolve })
    const paused = new Promise(resolve => { release = resolve })
    const h = harness(t, async () => undefined, {
      [method]: [{ fileName: target.fileName, textSpan: { start, length: 4 } }],
      openTextDocument: async () => { notifyEntered(); await paused; return target }
    })
    const token = { isCancellationRequested: false }
    const pending = method === 'definitions' ? h.advanced.definitions(source, source.positionAt(1), token) :
      h.references.provideReferences(source, source.positionAt(1), { includeDeclaration: true }, token)
    await entered
    source.version++
    release()
    assert.deepEqual(await pending, [], method)
  }
})

test('renaming a component member also renames its template usages', async t => {
  const text = `<template><p>{{ total }}</p></template>\n<script>export default { data() { return { total: 1 } } }</script>`
  const source = document(text, '/app/Page.vue')
  const { rename } = harness(t, localResolve)
  const edits = await rename.provideRenameEdits(source, source.positionAt(text.lastIndexOf('total') + 1), 'sum',
    { isCancellationRequested: false })
  assert.equal(edits.edits.length, 1)
  assert.equal(edits.edits[0].newText, 'sum')
  const expected = text.indexOf('{{ total }}') + '{{ '.length
  assert.deepEqual({ line: edits.edits[0].range.start.line, character: edits.edits[0].range.start.character },
    { line: 0, character: expected }, 'the edit points at the template occurrence, not the script one')
})

test('template loop aliases shadowing the member are left untouched', async t => {
  const text = `<template><p v-for="total in rows">{{ total }}</p></template>\n` +
    '<script>export default { data() { return { total: 1, rows: [] } } }</script>'
  const source = document(text, '/app/Page.vue')
  const { rename } = harness(t, localResolve)
  const edits = await rename.provideRenameEdits(source, source.positionAt(text.lastIndexOf('total: 1') + 1), 'sum',
    { isCancellationRequested: false })
  assert.equal(edits.edits.length, 0, 'a loop alias is not the component member')
})

test('renaming a prop rewrites parent template attributes only for this component', async t => {
  const childText = `<template><div/></template>\n<script>export default { props: ['userName'] }</script>`
  const child = document(childText, '/app/AddressTab.vue')
  const parentText = `<template><div><AddressTab :user-name="value" /><Other :user-name="value" /></div></template>\n` +
    `<script>\nimport AddressTab from './AddressTab.vue'\nimport Other from './Other.vue'\n` +
    'export default { components: { AddressTab, Other } }\n</script>'
  const parent = document(parentText, '/app/Parent.vue')
  const { rename, vscode } = harness(t, localResolve)
  vscode.workspace.textDocuments.push(parent)
  const edits = await rename.provideRenameEdits(child, child.positionAt(childText.indexOf('userName') + 1), 'nickName',
    { isCancellationRequested: false })
  assert.equal(edits.edits.length, 1)
  assert.equal(edits.edits[0].uri.fsPath, '/app/Parent.vue')
  assert.equal(edits.edits[0].newText, 'nick-name')
})

test('renaming a non-prop member never scans parent documents', async t => {
  const childText = `<template><div>{{ state }}</div></template>\n<script>export default { data() { return { state: 1 } } }</script>`
  const child = document(childText, '/app/AddressTab.vue')
  const parentText = `<template><AddressTab :state="value" /></template>\n<script>\nimport AddressTab from './AddressTab.vue'\n` +
    'export default { components: { AddressTab } }\n</script>'
  const parent = document(parentText, '/app/Parent.vue')
  const { rename, vscode } = harness(t, localResolve)
  vscode.workspace.textDocuments.push(parent)
  const edits = await rename.provideRenameEdits(child, child.positionAt(childText.lastIndexOf('state') + 1), 'next',
    { isCancellationRequested: false })
  assert.equal(edits.edits.length, 1, 'only the template expression in this file changes')
  assert.equal(edits.edits[0].uri.fsPath, '/app/AddressTab.vue')
})

test('missing relative resources are reported while aliases and remote URLs stay silent', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-resource-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'logo.png'), '')
  const text = '<template><div><img src="./logo.png"><img src="./missing.png"><img src="@src/alias.png">' +
    '<img src="https://example.com/x.png"></div></template>'
  const source = document(text, path.join(directory, 'Page.vue'))
  const h = harness(t, localResolve)
  h.vscode.window.activeTextEditor = { document: source }
  await h.commands['vueClick.checkCurrentFile']()
  const values = h.diagnostics.values.get(source.uri.toString()) || []
  const messages = values.map(value => value.message)
  assert.equal(values.length, 1, messages.join(' | '))
  assert.match(messages[0], /missing\.png/)
})

test('undefined template members surface as diagnostics on demand', async t => {
  const source = document('<template><p>{{ absent }}</p></template>\n' +
    '<script>export default { data() { return { present: 1 } } }</script>', '/app/Page.vue')
  const h = harness(t, localResolve)
  h.vscode.window.activeTextEditor = { document: source }
  await h.commands['vueClick.checkCurrentFile']()
  const values = h.diagnostics.values.get(source.uri.toString()) || []
  assert.deepEqual(values.map(value => source.getText(value.range)), ['absent'])
})

test('renaming a script local that shadows a member name leaves the template alone', async t => {
  const text = `<template><p>{{ total }}</p></template>\n<script>\nconst total = 1\n` +
    'export default { data() { return { total } } }\n</script>'
  const source = document(text, '/app/Page.vue')
  const { rename } = harness(t, localResolve)
  const edits = await rename.provideRenameEdits(source, source.positionAt(text.indexOf('const total') + 6), 'sum',
    { isCancellationRequested: false })
  assert.equal(edits.edits.length, 0, 'a script local is not the template member')
})

test('extensionless relative imports are not treated as missing resources', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-resource-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'theme.scss'), '')
  const text = '<template><div class="x"/></template>\n<script>import "./theme"\nimport "./theme.scss"</script>'
  const source = document(text, path.join(directory, 'Page.vue'))
  const h = harness(t, localResolve)
  h.vscode.window.activeTextEditor = { document: source }
  await h.commands['vueClick.checkCurrentFile']()
  const values = h.diagnostics.values.get(source.uri.toString()) || []
  assert.deepEqual(values.map(value => value.message), [])
})

test('template rename skips spans the script service already rewrites', async t => {
  const text = '<template>{{ total }}</template>\n<script>export default { data() { return { total: 1 } } }</script>'
  const source = document(text, '/app/Page.vue')
  const start = text.indexOf('{{ total }}') + '{{ '.length
  const h = harness(t, localResolve, {
    rename: [{ fileName: source.fileName, textSpan: { start, length: 'total'.length }, expectedText: 'total' }],
    documents: new Map([[source.fileName, source]])
  })
  const edits = await h.rename.provideRenameEdits(source, source.positionAt(text.lastIndexOf('total') + 1), 'sum',
    { isCancellationRequested: false })
  assert.equal(edits.edits.length, 1, 'overlapping edits would make VS Code drop the whole rename')
  assert.equal(edits.edits[0].newText, 'sum')
})

test('renaming a prop from its this. usage still updates parent templates', async t => {
  const childText = '<template><div/></template>\n<script>export default { props: [\'userName\'],\n' +
    '  methods: { run() { return this.userName } } }</script>'
  const child = document(childText, '/app/AddressTab.vue')
  const parentText = `<template><AddressTab :user-name="value" /></template>\n<script>\n` +
    "import AddressTab from './AddressTab.vue'\nexport default { components: { AddressTab } }\n</script>"
  const parent = document(parentText, '/app/Parent.vue')
  const { rename, vscode } = harness(t, localResolve)
  vscode.workspace.textDocuments.push(parent)
  const edits = await rename.provideRenameEdits(child, child.positionAt(childText.lastIndexOf('userName') + 1),
    'nickName', { isCancellationRequested: false })
  assert.equal(edits.edits.length, 1)
  assert.equal(edits.edits[0].uri.fsPath, '/app/Parent.vue')
  assert.equal(edits.edits[0].newText, 'nick-name')
})
