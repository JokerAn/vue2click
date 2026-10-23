'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerTagClosing } = require('../src/tag-closing')

function fixture(t) {
  const listeners = {}
  const subscribe = name => callback => {
    listeners[name] = callback
    return { dispose() { delete listeners[name] } }
  }
  const text = '<template><div>'
  const document = {
    languageId: 'vue', uri: {}, version: 1, isClosed: false,
    offsetAt: value => value, positionAt: value => value, getText: () => text
  }
  const offset = text.length
  const inserted = []
  const editor = {
    document,
    selection: { active: offset - 1, isEmpty: true },
    get selections() { return [this.selection] },
    insertSnippet: async snippet => { inserted.push(snippet.value) }
  }
  const vscode = {
    workspace: {
      onDidChangeTextDocument: subscribe('change'),
      getConfiguration: () => ({ get: () => true })
    },
    window: {
      activeTextEditor: editor,
      onDidChangeTextEditorSelection: subscribe('selection'),
      onDidChangeActiveTextEditor: subscribe('active')
    },
    SnippetString: class { constructor(value) { this.value = value } }
  }
  const context = { subscriptions: [] }
  registerTagClosing(vscode, context, () => ({}), {
    at: () => ({ language: 'html', document, parsed: {},
      service: { doTagComplete: () => '$0</div>' } })
  })
  t.after(() => { for (const entry of context.subscriptions) { entry.dispose() } })
  const change = () => listeners.change({ document, contentChanges: [
    { range: { start: offset - 1 }, rangeLength: 0, text: '>' }
  ] })
  const select = position => {
    editor.selection = { active: position, isEmpty: true }
    listeners.selection?.({ textEditor: editor, selections: editor.selections })
  }
  return { change, select, inserted, document, offset, vscode, listeners }
}

test('tag closing waits for the cursor update following a text change', async t => {
  const { change, select, inserted, offset } = fixture(t)
  change()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(inserted.length, 0)
  select(offset)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(inserted, ['$0</div>'])
  select(offset)
  assert.equal(inserted.length, 1, 'selection events must not insert a second closing tag')
})

test('tag closing discards a pending insertion after the user moves elsewhere', async t => {
  const { change, select, inserted, offset } = fixture(t)
  change()
  select(0)
  select(offset)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(inserted.length, 0)
})

test('tag closing discards a pending insertion after another edit or editor switch', async t => {
  const { change, select, inserted, document, offset, vscode, listeners } = fixture(t)
  change()
  document.version++
  select(offset)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(inserted.length, 0)
  select(offset - 1)
  change()
  vscode.window.activeTextEditor = undefined
  listeners.active?.()
  vscode.window.activeTextEditor = { document }
  select(offset)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(inserted.length, 0)
})
