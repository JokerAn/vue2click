'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { createModuleResolver } = require('../src/module-paths')

function document(fileName, initialText, version = 1) {
  let text = initialText
  return {
    fileName, version, languageId: 'vue', textReads: 0,
    uri: { fsPath: fileName, toString: () => 'file://' + fileName },
    getText() { this.textReads++; return text },
    update(next) { text = next; this.version++ },
    offsetAt(position) {
      const lines = text.split('\n')
      return lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) + position.character
    },
    positionAt(offset) {
      const lines = text.slice(0, offset).split('\n')
      return { line: lines.length - 1, character: lines.at(-1).length }
    }
  }
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-provider-'))
  const parentText = `<template><AddressTab :address-params="addressParams" @ok="gotoPage(1)" /></template>
<script>import AddressTab from './AddressTab.vue'
export default { components: { AddressTab }, data() { return { addressParams: {} } }, methods: { gotoPage(type) {} } }
</script>`
  const parent = document(path.join(directory, 'Parent.vue'), parentText)
  const childFile = path.join(directory, 'AddressTab.vue')
  // The resolver probes the filesystem, but the editor buffer is the source of definitions.
  fs.writeFileSync(childFile, `<script>export default { props: ['diskOnly'] }</script>`)
  const documents = new Map()
  const closeHandlers = []
  const calls = { opens: 0, resolutions: 0 }
  let provider
  let onOpen
  const vscode = {
    Uri: { file: fileName => ({ fsPath: fileName, toString: () => 'file://' + fileName }) },
    Range: class { constructor(start, end) { this.start = start; this.end = end } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range } },
    languages: {
      registerDefinitionProvider(selector, registered) { provider = registered; return { dispose() {} } }
    },
    workspace: {
      getWorkspaceFolder: () => ({ uri: { fsPath: directory } }),
      async openTextDocument(uri) {
        calls.opens++
        if (onOpen) await onOpen(uri)
        const doc = documents.get(uri.fsPath)
        if (!doc) throw new Error('missing editor document: ' + uri.fsPath)
        return doc
      },
      onDidCloseTextDocument(handler) { closeHandlers.push(handler); return { dispose() {} } }
    }
  }
  const extensionFile = require.resolve('../src/extension')
  const previousEntry = require.cache[extensionFile]
  const originalLoad = Module._load
  let extension
  try {
    delete require.cache[extensionFile]
    Module._load = function(request, parentModule, isMain) {
      if (request === 'vscode') return vscode
      if (request === './module-paths' && parentModule?.filename === extensionFile) {
        return { createModuleResolver(options) {
          const resolve = createModuleResolver(options)
          return async (...args) => { calls.resolutions++; return resolve(...args) }
        } }
      }
      return originalLoad.call(this, request, parentModule, isMain)
    }
    extension = require(extensionFile)
  } finally {
    Module._load = originalLoad
    delete require.cache[extensionFile]
    if (previousEntry) require.cache[extensionFile] = previousEntry
  }
  const context = { subscriptions: [] }
  extension.activate(context)
  t.after(() => {
    for (const subscription of context.subscriptions) subscription.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    parent, parentText, childFile, documents, calls,
    close: doc => closeHandlers.forEach(handler => handler(doc)),
    onOpen: callback => { onOpen = callback },
    query(reference = 'address-params', token = { isCancellationRequested: false }) {
      const offset = parentText.indexOf(reference)
      assert.ok(offset >= 0, 'missing reference')
      return provider.provideDefinition(parent, parent.positionAt(offset + 1), token)
    }
  }
}

function assertPropLocation(hit, child, text) {
  assert.ok(hit, 'expected a VS Code Location')
  assert.equal(hit.uri.fsPath, child.fileName)
  const start = text.indexOf('addressParams')
  assert.deepEqual(hit.range.start, child.positionAt(start))
  assert.deepEqual(hit.range.end, child.positionAt(start + 'addressParams'.length))
}

test('provider returns exact child buffer ranges and refreshes definitions after unsaved edits', async t => {
  const h = harness(t)
  const original = `<script>export default { props: { addressParams: Object } }</script>`
  const child = document(h.childFile, original)
  h.documents.set(h.childFile, child)
  assertPropLocation(await h.query(), child, original)
  const edited = `<template>🧩</template>\n<script>\nexport default {\n  props: { addressParams: Object }\n}\n</script>`
  child.update(edited)
  assertPropLocation(await h.query(), child, edited)
  assert.equal(child.textReads, 2, 'a new child version must rebuild its index')
  assert.equal(h.parent.textReads, 1, 'the unchanged parent index should be reused')
  assert.equal(h.calls.opens, 2, 'each query must obtain the current editor document')
})

test('provider abandons cancelled requests and parent edits during an asynchronous child load', async t => {
  const h = harness(t)
  h.documents.set(h.childFile, document(h.childFile, `<script>export default { props: { addressParams: Object } }</script>`))
  assert.equal(await h.query('address-params', { isCancellationRequested: true }), undefined)
  assert.deepEqual(h.calls, { opens: 0, resolutions: 0 })

  for (const invalidate of ['cancellation', 'parent edit']) {
    let notifyEntered
    let release
    const entered = new Promise(resolve => { notifyEntered = resolve })
    const paused = new Promise(resolve => { release = resolve })
    h.onOpen(() => { notifyEntered(); return paused })
    const token = { isCancellationRequested: false }
    const pending = h.query('address-params', token)
    await entered
    if (invalidate === 'cancellation') token.isCancellationRequested = true
    else h.parent.update(h.parentText + '\n<!-- edited during lookup -->')
    release()
    assert.equal(await pending, undefined, invalidate)
  }
})

test('closing a child document clears its cached index before a same-version reopening', async t => {
  const h = harness(t)
  const original = `<script>export default { props: { addressParams: Object } }</script>`
  const child = document(h.childFile, original)
  h.documents.set(h.childFile, child)
  assertPropLocation(await h.query(), child, original)
  assertPropLocation(await h.query(), child, original)
  assert.equal(child.textReads, 1, 'same-version queries should use the cached index')
  h.close(child)
  const edited = `<script>\n// reopened with another unsaved buffer\nexport default { props: { addressParams: Object } }</script>`
  const reopened = document(h.childFile, edited, child.version)
  h.documents.set(h.childFile, reopened)
  assertPropLocation(await h.query(), reopened, edited)
  assert.equal(reopened.textReads, 1, 'closed document cache must not survive reopening')
})

test('provider discards a stale barrel export changed while its child document is opening', async t => {
  const h = harness(t)
  const directory = path.dirname(h.childFile)
  const barrelFile = path.join(directory, 'barrel.js')
  const oldFile = path.join(directory, 'Old.vue')
  const newFile = path.join(directory, 'New.vue')
  const oldExport = "export { default } from './Old.vue'"
  const newExport = "export { default } from './New.vue'"
  const childText = `<script>export default { props: { addressParams: Object } }</script>`
  fs.writeFileSync(barrelFile, oldExport)
  fs.writeFileSync(oldFile, childText)
  fs.writeFileSync(newFile, childText)
  const barrel = document(barrelFile, oldExport)
  barrel.languageId = 'javascript'
  const oldChild = document(oldFile, childText)
  const newChild = document(newFile, '\n' + childText)
  h.documents.set(barrelFile, barrel)
  h.documents.set(oldFile, oldChild)
  h.documents.set(newFile, newChild)
  h.parent.update(h.parentText.replace("'./AddressTab.vue'", "'./barrel.js'"))
  assertPropLocation(await h.query(), oldChild, childText)

  let changed = false
  h.onOpen(uri => {
    if (uri.fsPath === oldFile) {
      assert.equal(barrel.textReads, 1, 'barrel must have been indexed before loading its child')
      barrel.update(newExport)
      changed = true
    }
  })
  assert.equal(await h.query(), undefined, 'an export edited during child loading invalidates the pending result')
  assert.equal(changed, true, 'the request must reach the old child load')

  h.onOpen(undefined)
  assertPropLocation(await h.query(), newChild, '\n' + childText)
  assert.equal(barrel.textReads, 2, 'the next lookup must index the updated unsaved barrel')
})

test('local parent event methods resolve without probing or opening component files', async t => {
  const h = harness(t)
  h.onOpen(() => { throw new Error('local definitions must not load children') })
  const hit = await h.query('gotoPage(1)')
  assert.ok(hit)
  assert.equal(hit.uri.fsPath, h.parent.fileName)
  const declaration = h.parentText.indexOf('gotoPage(type)')
  assert.deepEqual(hit.range.start, h.parent.positionAt(declaration))
  assert.deepEqual(hit.range.end, h.parent.positionAt(declaration + 'gotoPage'.length))
  assert.deepEqual(h.calls, { opens: 0, resolutions: 0 })
})

test('concurrent queries share an opening document but cancellation stays independent', async t => {
  const h = harness(t)
  const text = `<script>export default { props: { addressParams: Object } }</script>`
  const child = document(h.childFile, text)
  h.documents.set(h.childFile, child)
  let notifyEntered
  let release
  const entered = new Promise(resolve => { notifyEntered = resolve })
  const paused = new Promise(resolve => { release = resolve })
  h.onOpen(() => { notifyEntered(); return paused })
  const firstToken = { isCancellationRequested: false }
  const first = h.query('address-params', firstToken)
  const second = h.query()
  await entered
  // Let all continuations reach the shared pending open without a timed sleep.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.opens, 1)
  assert.equal(h.calls.resolutions, 1)
  firstToken.isCancellationRequested = true
  release()
  assert.equal(await first, undefined)
  assertPropLocation(await second, child, text)
  h.onOpen(undefined)
  assertPropLocation(await h.query(), child, text)
  assert.equal(h.calls.opens, 2, 'settled operations must not become a permanent document cache')
  assert.equal(h.calls.resolutions, 2, 'later queries must recheck file and configuration changes')
})

test('failed shared document opens are discarded so subsequent queries can recover', async t => {
  const h = harness(t)
  h.onOpen(() => { throw new Error('temporarily unavailable') })
  const results = await Promise.all([h.query(), h.query()])
  assert.deepEqual(results, [undefined, undefined])
  assert.equal(h.calls.opens, 1)
  const text = `<script>export default { props: { addressParams: Object } }</script>`
  const child = document(h.childFile, text)
  h.documents.set(h.childFile, child)
  h.onOpen(undefined)
  assertPropLocation(await h.query(), child, text)
  assert.equal(h.calls.opens, 2)
})

test('document index eviction keeps recent indexes and safely rebuilds older ones', async t => {
  const h = harness(t)
  const base = h.parentText
  const children = []
  for (let i = 0; i < 40; i++) {
    const file = path.join(path.dirname(h.childFile), `Child${i}.vue`)
    const text = `<script>export default { props: { addressParams: Object } }</script>`
    fs.writeFileSync(file, text)
    const child = document(file, text)
    children.push({ child, text })
    h.documents.set(file, child)
    h.parent.update(base.replace('./AddressTab.vue', `./Child${i}.vue`))
    assertPropLocation(await h.query(), child, text)
  }
  const recent = children.at(-1)
  assertPropLocation(await h.query(), recent.child, recent.text)
  assert.equal(recent.child.textReads, 1, 'a recently used document should stay cached')
  const first = children[0]
  h.parent.update(base.replace('./AddressTab.vue', './Child0.vue'))
  assertPropLocation(await h.query(), first.child, first.text)
  assert.equal(first.child.textReads, 2, 'old document indexes should not accumulate indefinitely')
})

test('shared barrel branches open each participating document once per request', async t => {
  const h = harness(t)
  const directory = path.dirname(h.childFile)
  const files = {
    'barrel.js': "export * from './left.js'; export * from './right.js'",
    'left.js': "export { default as Foo } from './AddressTab.vue'",
    'right.js': "export { default as Foo } from './AddressTab.vue'"
  }
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(directory, name)
    fs.writeFileSync(file, text)
    const source = document(file, text)
    source.languageId = 'javascript'
    h.documents.set(file, source)
  }
  const text = `<script>export default { props: { addressParams: Object } }</script>`
  const child = document(h.childFile, text)
  h.documents.set(h.childFile, child)
  h.parent.update(h.parentText.replace("import AddressTab from './AddressTab.vue'", "import { Foo as AddressTab } from './barrel.js'"))
  assertPropLocation(await h.query(), child, text)
  assert.equal(h.calls.opens, 4, 'the shared child should be opened once, alongside three distinct barrel files')
  assert.equal(child.textReads, 1)
})
