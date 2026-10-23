'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runAdvanced(directory) {
  console.log('Advanced Vue2 editing checks starting')
  const root = path.join(directory, 'semantic')
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.dirname(require.resolve('vue/package.json')), path.join(root, 'node_modules/vue'), 'dir')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, allowJs: true, checkJs: true, types: [], target: 'es2020', module: 'esnext', moduleResolution: 'node' },
    include: ['*.vue', '*.ts', '*.js']
  }))
  const content = `<template>
  <Child ref="dialog" @saved="save('demo', 2)" />
  <div v-for="row in rows">{{ row }} {{ count }}</div>
  <a href="./utils.ts">link</a>
</template>
<script lang="ts">
import Child from './Child.vue'
import mixin from './mixin'
export default {
  components:{Child}, mixins:[mixin],
  data() { return { count: 1, rows: ['one'] } },
  methods: {
    /** 保存一个名称。
     * @param name 用户名称
     * @param times 重复次数
     */
    save(name: string, times: number) { return name.repeat(times) },
    run() { this.save('demo', 2); this.shared(); this.$refs.dialog.open(); formatInv }
  }
}
</script>
<style lang="scss">
$brand: #ff0000;
.card { color: $brand; col }
</style>`
  const file = path.join(root, 'Parent.vue')
  fs.writeFileSync(file, content)
  fs.writeFileSync(path.join(root, 'Child.vue'), `<script>export default { methods: { open() { this.$emit('saved') } } }</script>`)
  fs.writeFileSync(path.join(root, 'mixin.js'), `export default { methods: { /** 共享方法。 */ shared() {} } }`)
  fs.writeFileSync(path.join(root, 'utils.ts'), '/** 格式化发票。 */ export function formatInvoice(value: string) { return value.trim() }')
  const document = await vscode.workspace.openTextDocument(file)
  await vscode.window.showTextDocument(document)
  const config = vscode.workspace.getConfiguration('vueClick', document.uri)
  assert.equal(config.get('diagnostics.enabled'), false, 'project diagnostics should be opt-in by default')
  await config.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Workspace)
  const position = (marker, extra = 1) => {
    const offset = document.getText().indexOf(marker)
    assert.ok(offset >= 0, marker)
    return document.positionAt(offset + extra)
  }
  const command = (name, marker, extra = 1, ...args) =>
    vscode.commands.executeCommand(name, document.uri, position(marker, extra), ...args)
  const outline = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)
  assert.ok(outline.some(value => value.name === 'methods' && value.children.some(child => child.name === 'save')))
  const hovers = await command('vscode.executeHoverProvider', 'this.save', 7)
  const hoverText = hovers.flatMap(value => value.contents).map(value => value.value || value).join('\n')
  assert.match(hoverText, /保存一个名称/)
  assert.match(hoverText, /name.*string/)
  console.log('Advanced outline and hover passed')
  const signature = await command('vscode.executeSignatureHelpProvider', "this.save('demo', 2)", 18)
  assert.ok(signature.signatures.some(value => /times: number/.test(value.label)))
  const references = await command('vscode.executeReferenceProvider', '{{ count }}', 4)
  assert.ok(references.some(value => document.getText(value.range) === 'count'))
  const rename = await command('vscode.executeDocumentRenameProvider', '{{ count }}', 4, 'total')
  const changes = rename.get(document.uri)
  assert.ok(changes.length >= 2)
  assert.ok(changes.every(edit => document.getText(edit.range) === 'count' && edit.newText === 'total'))
  console.log('Advanced signatures, references and rename passed')
  for (const [marker, extra, target, name] of [
    ['{{ row }}', 4, file, 'row'],
    ['this.shared', 7, path.join(root, 'mixin.js'), 'shared'],
    ['dialog.open', 8, path.join(root, 'Child.vue'), 'open'],
    ['@saved', 2, path.join(root, 'Child.vue'), "'saved'"]
  ]) {
    const definitions = await command('vscode.executeDefinitionProvider', marker, extra)
    assert.ok(definitions.some(value => value.uri.fsPath === target), marker)
    const definition = definitions.find(value => value.uri.fsPath === target)
    const targetDocument = await vscode.workspace.openTextDocument(target)
    assert.equal(targetDocument.getText(definition.range), name, marker)
  }
  const completions = await command('vscode.executeCompletionItemProvider', 'formatInv', 9, undefined, 1200)
  const imported = completions.items.find(value => value.label === 'formatInvoice')
  assert.ok(imported, 'auto import completion')
  assert.ok(imported.additionalTextEdits?.some(value => /import.*formatInvoice/.test(value.newText)), 'auto import must include actual import edits')
  console.log('Advanced navigation and auto import passed')
  const cssCompletion = await command('vscode.executeCompletionItemProvider', '; col', 5)
  assert.ok(cssCompletion.items.some(value => value.label === 'color'))
  const htmlCompletion = await command('vscode.executeCompletionItemProvider', '<a href=', 5)
  assert.ok(htmlCompletion.items.some(value => value.label === 'href'))
  const colors = await vscode.commands.executeCommand('vscode.executeDocumentColorProvider', document.uri)
  assert.ok(colors.length)
  const linked = await command('_executeLinkedEditingProvider', '<a href', 2)
  assert.equal(linked.ranges.length, 2)
  const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', document.uri)
  assert.ok(links.some(value => value.target?.fsPath === path.join(root, 'utils.ts')))
  const formatting = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri,
    { tabSize: 2, insertSpaces: true })
  assert.ok(formatting.length, 'embedded format provider returns block edits')
  assert.ok(formatting.some(edit => document.offsetAt(edit.range.start) > content.indexOf('<script') &&
    document.offsetAt(edit.range.end) < content.indexOf('</script>')), 'whole Vue formatter must include script edits')
  await config.update('formatting.enabled', false, vscode.ConfigurationTarget.Workspace)
  const noFormatting = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri,
    { tabSize: 2, insertSpaces: true })
  assert.ok(!noFormatting || noFormatting.length === 0, 'formatting can be handed to an external formatter')
  await config.update('formatting.enabled', undefined, vscode.ConfigurationTarget.Workspace)
  const edit = new vscode.WorkspaceEdit()
  const offset = content.indexOf("this.save('demo', 2)") + "this.save(".length
  edit.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + 6)), '123')
  await vscode.workspace.applyEdit(edit)
  const deadline = Date.now() + 20000
  let diagnostics
  do {
    diagnostics = vscode.languages.getDiagnostics(document.uri).filter(value => value.source === 'VueClick TS')
    if (diagnostics.some(value => value.code === 2345)) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.ok(diagnostics.some(value => value.code === 2345 && document.getText(value.range) === '123'), 'mapped type diagnostics')
  // A disabled project service still has reliable static JSDoc fallback.
  await config.update('languageService.enabled', false, vscode.ConfigurationTarget.Workspace)
  const fallback = await command('vscode.executeHoverProvider', 'this.save', 7)
  assert.match(fallback.flatMap(value => value.contents).map(value => value.value || value).join('\n'), /保存一个名称/)
  await config.update('languageService.enabled', undefined, vscode.ConfigurationTarget.Workspace)
  await config.update('diagnostics.enabled', undefined, vscode.ConfigurationTarget.Workspace)
  await require('./daily-editing').runDailyEditing(directory)
  console.log('Advanced Vue2 editing checks passed on VS Code ' + vscode.version)
}

module.exports = { runAdvanced }
