'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function fixture(options = {}) {
  const calls = []
  const settings = options.settings || {}
  const document = { languageId: 'javascript', fileName: '/app/Page.js', version: 1, uri: { scheme: 'file', fsPath: '/app/Page.js' } }
  const vscode = {
    CompletionItemKind: { Folder: 18, File: 16 },
    extensions: { getExtension: () => ({ isActive: options.active !== false }) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
    commands: { async executeCommand(...args) {
      calls.push(args)
      return options.response ? options.response(document) : { items: [
        { label: 'nested', kind: 18 }, { label: { label: 'other/' }, kind: 18 }, { label: 'helper', kind: 16 },
        { label: 'owned/', kind: 18, detail: 'VueClick resource directory' }
      ] }
    } }
  }
  return { vscode, document, calls }
}

test('native folder probing uses actual completion entries rather than extension activation as evidence', async () => {
  const { nativePathFolders } = require('../src/native-paths')
  const { vscode, document, calls } = fixture()
  const result = await nativePathFolders(vscode, document, { line: 2, character: 12 })
  assert.deepEqual([...result], ['nested', 'other'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'vscode.executeCompletionItemProvider')
  assert.equal(calls[0][1], document.uri)
  assert.deepEqual(calls[0][2], { line: 2, character: 12 })
  assert.equal(calls[0][4], 0, 'native directory probing must not resolve unrelated completion details')
})

test('inactive or disabled native path suggestions do not start or query a native service', async () => {
  const { nativePathFolders } = require('../src/native-paths')
  for (const options of [{ active: false }, { settings: { 'suggest.enabled': false } }, { settings: { 'suggest.paths': false } }]) {
    const { vscode, document, calls } = fixture(options)
    assert.deepEqual([...await nativePathFolders(vscode, document, { line: 0, character: 1 })], [])
    assert.equal(calls.length, 0)
  }
})

test('unavailable native completion results retain the static resource directory fallback', async () => {
  const { nativePathFolders } = require('../src/native-paths')
  for (const response of [() => undefined, () => ({ success: false }), () => { throw new Error('command unavailable') }]) {
    const { vscode, document } = fixture({ response })
    assert.deepEqual([...await nativePathFolders(vscode, document, { line: 0, character: 1 })], [])
  }
})

test('native probes preserve the original trigger character instead of impersonating a different editor operation', async () => {
  const { nativePathFolders } = require('../src/native-paths')
  const { vscode, document, calls } = fixture()
  await nativePathFolders(vscode, document, { line: 0, character: 12 }, undefined, document.version, { triggerCharacter: '-' })
  assert.equal(calls[0][3], '-')
})

test('cancelled and obsolete native probes must not become resource folder fallback results', async () => {
  const { nativePathFolders } = require('../src/native-paths')
  const stale = fixture()
  stale.document.version++
  assert.equal(await nativePathFolders(stale.vscode, stale.document, { line: 0, character: 1 }, undefined, 1), null)
  assert.equal(stale.calls.length, 0)
  const changed = fixture({ response(document) { document.version++; return { items: [] } } })
  assert.equal(await nativePathFolders(changed.vscode, changed.document, { line: 0, character: 1 }), null)
  const cancelled = fixture()
  assert.equal(await nativePathFolders(cancelled.vscode, cancelled.document, { line: 0, character: 1 }, { isCancellationRequested: true }), null)
  assert.equal(cancelled.calls.length, 0)
})
