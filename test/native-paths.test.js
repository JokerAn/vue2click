'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { nativeOwnsDirectory } = require('../src/native-paths')

function fixture(options = {}) {
  const settings = options.settings || {}
  const document = { languageId: 'javascript', version: 1, uri: { scheme: 'file', fsPath: '/app/Page.js' } }
  let activations = 0
  const extension = { isActive: options.active !== false, async activate() {
    activations++
    await options.activate?.(document)
    this.isActive = true
  } }
  const vscode = {
    extensions: { getExtension: () => options.missing ? undefined : extension },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
    commands: { executeCommand() { assert.fail('directory ownership must not query other completion providers') } }
  }
  return { vscode, document, activations: () => activations }
}

test('native and extension-only directories have stable owners without nested provider requests', async () => {
  const { vscode, document } = fixture()
  for (let index = 0; index < 20; index++) {
    assert.equal(await nativeOwnsDirectory(vscode, document, { nativeDirectory: true }), true)
    assert.equal(await nativeOwnsDirectory(vscode, document, { nativeDirectory: false }), false)
  }
})

test('missing or disabled native paths keep extension directory candidates', async () => {
  for (const options of [{ missing: true }, { settings: { 'suggest.enabled': false } }, { settings: { 'suggest.paths': false } }]) {
    const { vscode, document, activations } = fixture(options)
    assert.equal(await nativeOwnsDirectory(vscode, document, { nativeDirectory: true }), false)
    assert.equal(activations(), 0)
  }
})

test('concurrent calls share directory ownership without an in-flight probing guard', async () => {
  const { vscode, document } = fixture()
  assert.deepEqual(await Promise.all([0, 1, 2].map(() =>
    nativeOwnsDirectory(vscode, document, { nativeDirectory: true }))), [true, true, true])
})

test('activation is awaited and failures preserve the directory fallback', async () => {
  const ready = fixture({ active: false })
  assert.equal(await nativeOwnsDirectory(ready.vscode, ready.document, { nativeDirectory: true }), true)
  assert.equal(ready.activations(), 1)
  const failed = fixture({ active: false, activate() { throw new Error('native service unavailable') } })
  assert.equal(await nativeOwnsDirectory(failed.vscode, failed.document, { nativeDirectory: true }), false)
})

test('cancelled and obsolete requests cannot publish directory ownership decisions', async () => {
  const stale = fixture()
  stale.document.version++
  assert.equal(await nativeOwnsDirectory(stale.vscode, stale.document, { nativeDirectory: true }, undefined, 1), null)
  const changed = fixture({ active: false, activate(document) { document.version++ } })
  assert.equal(await nativeOwnsDirectory(changed.vscode, changed.document, { nativeDirectory: true }), null)
  const cancelled = fixture()
  assert.equal(await nativeOwnsDirectory(cancelled.vscode, cancelled.document, { nativeDirectory: true }, { isCancellationRequested: true }), null)
})
