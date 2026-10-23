'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runDailyEditing(directory) {
  const root = path.join(directory, 'daily')
  fs.mkdirSync(root)
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.symlinkSync(path.dirname(require.resolve('vue/package.json')), path.join(root, 'node_modules/vue'), 'dir')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true,
    strict: true, types: [], module: 'esnext', target: 'es2020' }, include: ['*.vue', '*.ts'] }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    vetur: { tags: 'tags.json', attributes: 'attributes.json' }
  }))
  fs.writeFileSync(path.join(root, 'tags.json'), JSON.stringify({
    'acme-panel': { attributes: ['mode', 'enabled', 'saved'] }
  }))
  fs.writeFileSync(path.join(root, 'attributes.json'), JSON.stringify({
    'acme-panel/mode': { type: 'string', options: ['edit', 'view'] },
    'acme-panel/enabled': { type: 'boolean', options: [true, false] },
    'acme-panel/saved': { type: 'event', description: 'Saved by metadata.' }
  }))
  fs.writeFileSync(path.join(root, 'choices.ts'), "export type Mode = 'edit' | 'view'")
  fs.writeFileSync(path.join(root, 'barrel.ts'), "export type { Mode } from './choices'")
  fs.writeFileSync(path.join(root, 'Child.vue'), `<script lang="ts">import type { Mode } from './barrel'
export default { props: {
    /** Display mode. */ mode: { type: String as PropType<Mode>, required: true, default: 'view' }
  }, emits: { /** Saved payload. */ saved(value: string) { return true } } }</script>`)
  fs.writeFileSync(path.join(root, 'InvoiceDialog.vue'), '<script>export default {}</script>')
  fs.writeFileSync(path.join(root, 'utils.ts'), 'export const kept = 1; export const unused = 2; export function formatInvoice(value: string) { return value.trim() }')
  const content = `<template>
<Child :mode="'view'" @saved="run" />
<Child :mode="form.ship" />
<Child @saved="form.ship" />
<AcmePanel mode="" :enabled="false" @saved="run" />
{{ kept }}
<Invoice />
ul>li*3
</template>
<script lang="ts">
import Child from './Child.vue'
import { kept, unused } from './utils'
const total=1
function inner(total: number) {
 return total+1
}
export default { components: { Child }, data() { return { form: { shippingMode: 'edit' } } },
  methods: { run() { return formatInvoice('test') } } }
</script>
<style>.x { m10 }</style>`
  const file = path.join(root, 'Parent.vue')
  fs.writeFileSync(file, content)
  const document = await vscode.workspace.openTextDocument(file)
  const editor = await vscode.window.showTextDocument(document)
  const config = vscode.workspace.getConfiguration('vueClick', document.uri)
  assert.equal(config.get('diagnostics.enabled'), false)
  const initialState = await vscode.commands.executeCommand('vueClick.showProjectInfo')
  assert.equal(initialState.state, 'not-started', 'viewing service status must not start project analysis')
  assert.equal(initialState.automaticDiagnostics, false)
  const offset = marker => document.getText().indexOf(marker)
  const command = (name, marker, extra = 0, ...args) =>
    vscode.commands.executeCommand(name, document.uri, document.positionAt(offset(marker) + extra), ...args)
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(vscode.languages.getDiagnostics(document.uri).filter(value => value.source === 'VueClick TS').length, 0)
  const hover = await command('vscode.executeHoverProvider', ':mode', 2)
  const markdown = hover.flatMap(value => value.contents).map(value => value.value || value).join('\n')
  assert.match(markdown, /required/)
  assert.match(markdown, /Display mode/)
  const values = await command('vscode.executeCompletionItemProvider', ':mode="', 7)
  assert.ok(values.items.some(value => value.label === "'edit'"))
  const events = await command('vscode.executeCompletionItemProvider', '@saved', 1)
  assert.ok(events.items.some(value => value.label === 'saved' && /Saved payload/.test(value.documentation?.value || '')))
  for (const marker of [':mode="form.ship', '@saved="form.ship']) {
    const members = await command('vscode.executeCompletionItemProvider', marker, marker.length)
    assert.ok(members.items.some(value => value.label === 'shippingMode'),
      'component metadata must preserve semantic member completions in ' + marker)
  }
  assert.equal((await vscode.commands.executeCommand('vueClick.showProjectInfo')).state, 'ready')
  assert.equal(await vscode.commands.executeCommand('vueClick.restartLanguageService'), true)
  assert.equal((await vscode.commands.executeCommand('vueClick.showProjectInfo')).state, 'not-started')
  const recovered = await command('vscode.executeHoverProvider', ':mode', 2)
  assert.match(recovered.flatMap(value => value.contents).map(value => value.value || value).join('\n'), /required/)
  const metadataEvents = await command('vscode.executeCompletionItemProvider', ':enabled="false" @', ':enabled="false" @'.length)
  assert.ok(metadataEvents.items.some(value => value.label === 'saved' && /Saved by metadata/.test(value.documentation?.value)))
  const metadataValues = await command('vscode.executeCompletionItemProvider', '<AcmePanel mode="', '<AcmePanel mode="'.length)
  assert.ok(metadataValues.items.some(value => value.label === 'edit'))
  const primitiveValues = await command('vscode.executeCompletionItemProvider', ':enabled="', ':enabled="'.length)
  assert.ok(primitiveValues.items.some(value => value.label === 'true' && value.insertText === 'true'))
  const imports = await command('vscode.executeCompletionItemProvider', '<Invoice', 8, undefined, 50)
  const candidate = imports.items.find(value => value.label === 'InvoiceDialog' && value.additionalTextEdits?.length)
  assert.ok(candidate, 'template component candidate must import and register')
  assert.ok(candidate.additionalTextEdits.some(edit => edit.newText.includes('InvoiceDialog.vue')))
  const highlights = await command('vscode.executeDocumentHighlights', 'return total', 8)
  assert.equal(highlights.filter(value => document.getText(value.range) === 'total').length, 2)
  const selection = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', document.uri,
    [document.positionAt(offset('return total') + 8)])
  assert.ok(selection[0].parent)
  const folding = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri)
  assert.ok(folding.some(value => value.start === document.positionAt(offset('function inner')).line))
  const emmet = await command('vscode.executeCompletionItemProvider', 'ul>li*3', 7, undefined, 1000)
  assert.equal(emmet.items.filter(value => value.label === 'ul>li*3').length, 1,
    `Emmet should be available once (native active: ${vscode.extensions.getExtension('vscode.emmet')?.isActive}; labels: ${emmet.items.map(value => value.label).slice(0, 12).join(', ')})`)
  const emmetConfig = vscode.workspace.getConfiguration('emmet', document.uri)
  await emmetConfig.update('includeLanguages', { vue: 'html' }, vscode.ConfigurationTarget.Workspace)
  const nativeEmmet = await command('vscode.executeCompletionItemProvider', 'ul>li*3', 7, undefined, 1000)
  assert.equal(nativeEmmet.items.filter(value => value.label === 'ul>li*3').length, 1, 'native Vue Emmet mapping must not be duplicated')
  await emmetConfig.update('includeLanguages', undefined, vscode.ConfigurationTarget.Workspace)
  const single = await vscode.commands.executeCommand('vueClick.checkCurrentFile')
  assert.equal(typeof single, 'number')
  assert.equal(config.get('diagnostics.enabled'), false, 'single check must not enable automatic diagnostics')
  const diagnostics = vscode.languages.getDiagnostics(document.uri)
  assert.ok(diagnostics.some(value => value.code === 2304 && document.getText(value.range) === 'formatInvoice'))
  const fixes = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri,
    new vscode.Range(document.positionAt(offset('formatInvoice')), document.positionAt(offset('formatInvoice') + 13)),
    vscode.CodeActionKind.QuickFix.value, 20)
  assert.ok(fixes.some(value => value.edit?.entries().some(([, edits]) => edits.some(edit => edit.newText.includes('formatInvoice')))),
    JSON.stringify({ fixes: fixes.map(value => ({ title: value.title, edits: value.edit?.entries() })),
      diagnostics: diagnostics.map(value => ({ code: value.code, text: document.getText(value.range) })) }))
  const remove = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri,
    new vscode.Range(0, 0, 0, 0), 'source.removeUnusedImports', 20)
  const removal = remove.find(value => value.title === 'VueClick: 移除未使用 import')
  assert.ok(removal?.edit)
  await vscode.workspace.applyEdit(removal.edit)
  assert.match(document.getText(), /import.*kept/)
  assert.ok(!/import.*unused/.test(document.getText()))
  const tagSource = '<template>\n<div\n</template><script>export default {}</script>'
  const replace = new vscode.WorkspaceEdit()
  replace.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), tagSource)
  await vscode.workspace.applyEdit(replace)
  const position = document.positionAt(document.getText().indexOf('<div') + 4)
  editor.selection = new vscode.Selection(position, position)
  await vscode.commands.executeCommand('type', { text: '>' })
  const closingDeadline = Date.now() + 2000
  while (!document.getText().includes('<div></div>') && Date.now() < closingDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.match(document.getText(), /<div><\/div>/)
  assert.equal(document.getText().match(/<\/div>/g).length, 1)
  await config.update('autoClosingTags.enabled', false, vscode.ConfigurationTarget.Workspace)
  const empty = new vscode.WorkspaceEdit()
  const divClose = document.positionAt(document.getText().indexOf('</div>'))
  empty.replace(document.uri, new vscode.Range(divClose, divClose), '\n<span')
  await vscode.workspace.applyEdit(empty)
  const spanEnd = document.positionAt(document.getText().indexOf('<span') + '<span'.length)
  editor.selection = new vscode.Selection(spanEnd, spanEnd)
  await vscode.commands.executeCommand('type', { text: '>' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(!document.getText().includes('<span></span>'), 'auto close setting must be respected')
  console.log('Daily editing checks passed: metadata, imports, script navigation, diagnostics, fixes, Emmet and closing tags')
}

module.exports = { runDailyEditing }
