'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { TextDocument } = require('vscode-languageserver-textdocument')
const { registerCopyCode } = require('../src/copy-code')
const manifest = require('../package.json')

function harness(filePath = '/workspace/src/申请.vue', relativePath = 'src/申请.vue') {
  const selected = '<div class="itemEl">\r\n  <span>申请原因</span>\r\n  <span>{{ details.applyReason }}</span>\r\n</div>'
  const source = TextDocument.create('file:///workspace/src/申请.vue', 'vue', 2,
    '\n'.repeat(196) + '    ' + selected + '\r\n<!-- outside selection -->')
  const uri = { scheme: 'file', fsPath: filePath, toString: () => source.uri }
  const selection = {
    start: source.positionAt(source.getText().indexOf('<div')),
    end: source.positionAt(source.getText().indexOf('</div>') + '</div>'.length),
    isEmpty: false
  }
  const commands = new Map()
  const copied = []
  const context = { subscriptions: [] }
  const vscode = {
    commands: {
      registerCommand(name, run) {
        commands.set(name, run)
        return { dispose() { commands.delete(name) } }
      }
    },
    window: { activeTextEditor: { document: { uri, getText: range => source.getText(range) }, selection } },
    workspace: {
      asRelativePath(value, includeWorkspaceFolder) {
        assert.equal(value, uri)
        assert.equal(includeWorkspaceFolder, false, 'use the containing workspace root in multi-root workspaces')
        return relativePath
      }
    },
    env: { clipboard: { async writeText(text) { copied.push(text) } } }
  }
  registerCopyCode(vscode, context)
  return { vscode, context, commands, copied, selected, selection, uri }
}

test('copies both paths with 1-based start/end lines and columns and the exact reverse selection text', async () => {
  const h = harness()
  // Reverse selections still use the normalized start, rather than the active cursor.
  h.selection.anchor = h.selection.end
  h.selection.active = h.selection.start
  await h.commands.get('vueClick.copyCodeWithAbsolutePath')(h.uri)
  await h.commands.get('vueClick.copyCodeWithRelativePath')()
  assert.deepEqual(h.copied, [
    `/workspace/src/申请.vue:197:5-200:7 ${h.selected}`,
    `src/申请.vue:197:5-200:7 ${h.selected}`
  ])
  for (const subscription of h.context.subscriptions) {
    subscription.dispose()
  }
  assert.equal(h.commands.size, 0)
})

test('normalizes Windows path separators without changing selected code', async () => {
  const h = harness('C:\\workspace\\src\\申请.vue', 'src\\申请.vue')
  await h.commands.get('vueClick.copyCodeWithAbsolutePath')()
  await h.commands.get('vueClick.copyCodeWithRelativePath')()
  assert.deepEqual(h.copied, [`C:/workspace/src/申请.vue:197:5-200:7 ${h.selected}`, `src/申请.vue:197:5-200:7 ${h.selected}`])
})

test('keeps the absolute location when the relative-path API has no workspace', async () => {
  const h = harness('/outside/Page.vue', '/outside/Page.vue')
  await h.commands.get('vueClick.copyCodeWithRelativePath')()
  assert.deepEqual(h.copied, [`/outside/Page.vue:197:5-200:7 ${h.selected}`])
})

test('does not replace the clipboard for empty selections, unsaved files, or a different context document', async () => {
  const h = harness()
  for (const run of h.commands.values()) {
    h.selection.isEmpty = true
    await run()
    h.selection.isEmpty = false
    h.uri.scheme = 'untitled'
    await run()
    h.uri.scheme = 'file'
    await run({ toString: () => 'file:///other.vue' })
  }
  h.vscode.window.activeTextEditor = undefined
  await h.commands.get('vueClick.copyCodeWithAbsolutePath')()
  assert.deepEqual(h.copied, [])
})

test('both commands copy precise columns of a partial single-line selection', async () => {
  const h = harness()
  h.selection.start = { line: 197, character: 8 }
  h.selection.end = { line: 197, character: 12 }
  for (const run of h.commands.values()) {
    await run()
  }
  assert.deepEqual(h.copied, [
    '/workspace/src/申请.vue:198:9-198:13 申请原因',
    'src/申请.vue:198:9-198:13 申请原因'
  ])
})

test('keeps a precise range ending at the start of the next line and includes the selected newline', async () => {
  const h = harness()
  h.selection.end = { line: 200, character: 0 }
  for (const run of h.commands.values()) {
    await run()
  }
  assert.deepEqual(h.copied, [
    `/workspace/src/申请.vue:197:5-201:1 ${h.selected}\r\n`,
    `src/申请.vue:197:5-201:1 ${h.selected}\r\n`
  ])
})

test('contributes a selection-only editor submenu with all registered commands', () => {
  const { contributes } = manifest
  const submenu = contributes.submenus.find(value => value.label === '复制代码和行数')
  assert.ok(submenu)
  const entry = contributes.menus['editor/context'].find(value => value.submenu === submenu.id)
  assert.equal(entry.when, 'editorHasSelection && resourceScheme == file')
  const commands = contributes.menus[submenu.id].map(value => value.command)
  assert.deepEqual(commands, [...harness().commands.keys()])
  assert.deepEqual(commands.map(command => contributes.commands.find(value => value.command === command).title),
    ['完全路径', '相对路径'])
  assert.ok(!contributes.commands.some(value => value.command === 'vueClick.copyCodeWithPreciseLocation'))
})
