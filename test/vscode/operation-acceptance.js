'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runOperationAcceptance(directory) {
  const root = path.join(directory, 'operations')
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.dirname(require.resolve('vue/package.json')), path.join(root, 'node_modules/vue'), 'dir')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, types: [] }, include: ['*.vue', '*.ts'] }))
  fs.writeFileSync(path.join(root, 'utils.ts'), 'export function formatUniqueInvoice(value: string) { return value.trim() }')
  const file = path.join(root, 'Operations.vue')
  fs.writeFileSync(file, '<template>div</template>')
  const document = await vscode.workspace.openTextDocument(file)
  const editor = await vscode.window.showTextDocument(document)
  const at = marker => document.positionAt(document.getText().indexOf(marker) + marker.length)
  async function replace(text, marker) {
    await vscode.commands.executeCommand('hideSuggestWidget')
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)
    await vscode.workspace.applyEdit(edit)
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    if (marker) editor.selection = new vscode.Selection(at(marker), at(marker))
  }
  async function undo(expected, message) {
    await vscode.commands.executeCommand('undo')
    assert.equal(document.getText(), expected, message)
  }
  async function accept(marker, label, expectedText) {
    const prefix = marker.slice(marker.lastIndexOf('.') + 1)
    const end = at(marker)
    const start = document.positionAt(document.offsetAt(end) - prefix.length)
    editor.selection = new vscode.Selection(start, end)
    await vscode.commands.executeCommand('type', { text: prefix })
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at(marker), undefined, 100)
    assert.ok(list.items.some(item => item.label === label), label)
    const before = document.getText()
    for (let choice = 0; choice < Math.min(list.items.length + 8, 40); choice++) {
      editor.selection = new vscode.Selection(at(marker), at(marker))
      await vscode.commands.executeCommand('editor.action.triggerSuggest')
      await new Promise(resolve => setTimeout(resolve, 250))
      await vscode.commands.executeCommand('selectFirstSuggestion')
      for (let step = 0; step < choice; step++) await vscode.commands.executeCommand('selectNextSuggestion')
      await vscode.commands.executeCommand('acceptSelectedSuggestion')
      if (document.getText().includes(expectedText)) return before
      if (document.getText() !== before) await undo(before, 'an alternative suggestion must be independently undoable')
    }
    assert.fail('completion was not accepted through the suggestion UI: ' + label + '; text=' + document.getText() + '; selection=' + JSON.stringify(editor.selection))
  }
  const emmet = vscode.workspace.getConfiguration('emmet', document.uri)
  for (const mapping of [undefined, { vue: 'html' }]) {
    await emmet.update('includeLanguages', mapping, vscode.ConfigurationTarget.Workspace)
    for (const [text, marker] of [['<template>ul>li*3</template>', 'ul>li*3'], ['<style>.x { m10 }</style>', 'm10']]) {
      await replace(text, marker)
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at(marker), undefined, 1000)
      const expanded = list.items.filter(item => marker === 'm10'
        ? /margin:\s*10px/.test(typeof item.insertText === 'string' ? item.insertText : item.insertText?.value || String(item.label))
        : item.label === marker)
      assert.equal(expanded.length, 1, 'Emmet must be available exactly once: ' + marker + ', mapping=' + JSON.stringify(mapping))
    }
  }
  await replace('<template>\ndiv\n</template>', 'div')
  const abbreviation = document.getText()
  await vscode.commands.executeCommand('editor.emmet.action.expandAbbreviation')
  assert.match(document.getText(), /<div><\/div>/)
  assert.equal(document.offsetAt(editor.selection.active), document.getText().indexOf('<div>') + 5)
  await undo(abbreviation, 'Emmet expansion must be one undoable operation')
  await emmet.update('includeLanguages', undefined, vscode.ConfigurationTarget.Workspace)

  await replace('<script>export default { data() { return { form: { shippingMode: "edit" } } }, methods: { run() { this.for } } }</script>', 'this.for')
  await undo(await accept('this.for', 'form', 'this.form'), 'member completion undo must restore the typed prefix')
  await replace('<script>export default { data() { return { form: { shippingMode: "edit" } } }, methods: { run() { this.form.ship } } }</script>', 'this.form.ship')
  await undo(await accept('this.form.ship', 'shippingMode', 'this.form.shippingMode'), 'deep completion undo must restore the typed prefix')
  await replace('<script lang="ts">export default { methods: { run() { formatUniqueInv } } }</script>', 'formatUniqueInv')
  const beforeImport = await accept('formatUniqueInv', 'formatUniqueInvoice', 'formatUniqueInvoice')
  assert.match(document.getText(), /import\s*\{[^}]*formatUniqueInvoice/)
  await undo(beforeImport, 'completion insertion and auto import must undo together')

  await replace('<template><button @click="submit(row)"/></template><script>export default { data() { return { row: {} } } }</script>', 'submit')
  const beforeMethod = document.getText()
  const selection = new vscode.Range(at('submit'), at('submit'))
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, selection, vscode.CodeActionKind.QuickFix.value, 20)
  const method = actions.find(action => action.title === 'VueClick: 生成方法 submit')
  assert.ok(method?.edit)
  await vscode.workspace.applyEdit(method.edit)
  assert.match(document.getText(), /submit\(row\)\s*\{/)
  await undo(beforeMethod, 'method generation must undo as one edit')

  await replace('<template>{{ amount }}</template><script>export default { data() { return { amount: 1 } }, methods: { run() { return this.amount } } }</script>', 'this.amount')
  const beforeRename = document.getText()
  const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, at('this.amou'), 'total')
  assert.ok(rename)
  await vscode.workspace.applyEdit(rename)
  assert.match(document.getText(), /\{\{ total \}\}/)
  assert.match(document.getText(), /this\.total/)
  await undo(beforeRename, 'semantic rename must undo template and script edits together')

  await replace('<template>\n<div\n</template>', '<div')
  const beforeClosing = document.getText()
  await vscode.commands.executeCommand('type', { text: '>' })
  const deadline = Date.now() + 2000
  // Snippet text and its final cursor reach the extension host separately.
  while ((!document.getText().includes('<div></div>') ||
    document.offsetAt(editor.selection.active) !== document.getText().indexOf('<div>') + 5) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.match(document.getText(), /<div><\/div>/)
  assert.equal(document.offsetAt(editor.selection.active), document.getText().indexOf('<div>') + 5)
  await undo(beforeClosing, 'typed delimiter and inserted closing tag must undo together')
  console.log('Operation acceptance passed: Emmet command/cursor, native/fallback suggestions, member/deep/auto-import acceptance, method/rename/closing undo')
}

module.exports = { runOperationAcceptance }
