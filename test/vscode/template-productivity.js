'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runTemplateProductivity(directory) {
  const root = path.join(directory, 'productivity')
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.dirname(require.resolve('vue/package.json')), path.join(root, 'node_modules/vue'), 'dir')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { allowJs: true, checkJs: true, types: [], strict: true },
    include: ['*.vue']
  }))
  const child = `<template><div><slot name="header"/><slot name="row" :item="item" :index="index"/></div></template>
<script>export default { data() { return { item: {}, index: 0 } } }</script>`
  fs.writeFileSync(path.join(root, 'Child.vue'), child)
  const stylesheet = path.join(root, 'theme.scss')
  fs.writeFileSync(stylesheet, '.external-card { color: red }')
  const content = `<template>
<div class="local-card external-card" id="invoice">
<Child><template #header>Header</template><template #row="{ item }">{{ item }}</template></Child>
<button @click="submit(row)">Save</button>
</div>
</template>
<script>
import Child from './Child.vue'
import './theme.scss'
export default { components: { Child }, data() { return { row: {} } } }
</script>
<style scoped>.local-card { color: blue } #invoice { display: block }</style>`
  const file = path.join(root, 'Parent.vue')
  fs.writeFileSync(file, content)
  const document = await vscode.workspace.openTextDocument(file)
  await vscode.window.showTextDocument(document)
  const at = (marker, extra = 0) => document.positionAt(document.getText().indexOf(marker) + extra)
  const command = (name, marker, extra = 0, ...args) =>
    vscode.commands.executeCommand(name, document.uri, at(marker, extra), ...args)
  assert.equal((await vscode.commands.executeCommand('vueClick.showProjectInfo')).state, 'not-started')
  for (const [marker, expected] of [['local-card external', '.local-card'], ['invoice"', '#invoice']]) {
    const hits = await command('vscode.executeDefinitionProvider', marker, 2)
    assert.ok(hits.some(hit => hit.uri.fsPath === file && document.getText(hit.range) === expected), marker)
  }
  let hits = await command('vscode.executeDefinitionProvider', 'external-card"', 3)
  assert.ok(hits.some(hit => hit.uri.fsPath === stylesheet))
  assert.equal((await vscode.commands.executeCommand('vueClick.showProjectInfo')).state, 'not-started',
    'template style navigation must not start project semantics')
  const external = await vscode.workspace.openTextDocument(stylesheet)
  const edit = new vscode.WorkspaceEdit()
  const updated = '\n\n.external-card { color: green }'
  edit.replace(external.uri, new vscode.Range(external.positionAt(0), external.positionAt(external.getText().length)), updated)
  await vscode.workspace.applyEdit(edit)
  hits = await command('vscode.executeDefinitionProvider', 'external-card"', 3)
  assert.ok(hits.some(hit => hit.uri.fsPath === stylesheet && hit.range.start.line === 2),
    'linked stylesheet definitions must use unsaved source positions')

  const names = await command('vscode.executeCompletionItemProvider', '#header', 3)
  assert.ok(names.items.some(item => item.label === 'header' && /Vue slot/.test(item.detail)))
  const parameters = await command('vscode.executeCompletionItemProvider', '#row="{ item', '#row="{ it'.length)
  assert.ok(parameters.items.some(item => item.label === 'item' && /Slot row/.test(item.detail)))
  assert.ok(parameters.items.some(item => item.label === 'index'))
  const selection = new vscode.Range(at('submit(row)', 2), at('submit(row)', 2))
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
    document.uri, selection, vscode.CodeActionKind.QuickFix.value, 20)
  const action = actions.find(action => action.title === 'VueClick: 生成方法 submit')
  assert.ok(action?.edit, 'manual quick fix must create a missing event method without enabling diagnostics')
  const before = document.getText()
  await vscode.workspace.applyEdit(action.edit)
  assert.match(document.getText(), /submit\(row\)\s*\{/)
  assert.match(document.getText(), /@click="submit\(row\)"/)
  const again = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
    document.uri, new vscode.Range(at('submit(row)', 2), at('submit(row)', 2)), vscode.CodeActionKind.QuickFix.value, 20)
  assert.ok(!again.some(action => action.title === 'VueClick: 生成方法 submit'),
    'a generated method must not be offered a second time')
  assert.equal(vscode.workspace.getConfiguration('vueClick', document.uri).get('diagnostics.enabled'), false)
  assert.notEqual(document.getText(), before)
  console.log('Template productivity checks passed: local/linked styles, unsaved offsets, slots and missing event methods')
}

module.exports = { runTemplateProductivity }
