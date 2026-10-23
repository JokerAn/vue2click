'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { createHash } = require('node:crypto')
const vscode = require('vscode')
const { grammarRegistry, tokens } = require('../helpers/grammar')

async function run() {
  const extension = vscode.extensions.getExtension('jokeran.vueClick')
  assert.ok(extension, 'development extension must be registered')
  await extension.activate()
  for (const other of ['octref.vetur', 'Vue.volar']) {
    assert.equal(vscode.extensions.getExtension(other), undefined, 'standalone tests must not load ' + other)
  }
  const directory = process.env.VUECLICK_TEST_WORKSPACE
  const childFile = path.join(directory, 'AddressTab.vue')
  fs.writeFileSync(childFile, `<script>export default { props: ['addressParams'] }</script>`)
  const content = `<template>
  <AddressTab :address-params="count" @click="save" />
  <div>{{ count }}</div>
</template>
<script>
import AddressTab from './AddressTab.vue'
export default {
  components: { AddressTab },
  data() { return { count: 0 } },
  methods: { save() { this.count } }
}
</script>
<style scoped>
.card { color: red; }
</style>`
  const file = path.join(directory, 'Parent.vue')
  fs.writeFileSync(file, content)
  const document = await vscode.workspace.openTextDocument(file)
  const editor = await vscode.window.showTextDocument(document)
  assert.equal(document.languageId, 'vue', 'Vue files must be recognized without Vetur')

  const complete = async (source, marker) => {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source)
    assert.equal(await vscode.workspace.applyEdit(edit), true)
    const offset = document.getText().indexOf(marker)
    assert.ok(offset >= 0, marker)
    return vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
      document.uri, document.positionAt(offset + marker.length))
  }
  let list = await complete(content, 'this.')
  assert.ok(list.items.some(item => item.label === 'count' && item.detail === 'Vue data'))
  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
    document.uri, document.positionAt(document.getText().indexOf('this.count') + 6))
  assert.ok(definitions.some(hit => hit.uri.fsPath === file &&
    document.getText(hit.range) === 'count'), 'existing member definitions must still work')
  async function assertComment(marker, expected) {
    const position = document.positionAt(document.getText().indexOf(marker))
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    editor.selection = new vscode.Selection(position, position)
    const original = document.lineAt(position.line).text
    const deadline = Date.now() + 5000
    let actual
    // TextMate loads asynchronously on first open. Wait for the real editor
    // operation to use its embedded grammar, failing if it never becomes ready.
    do {
      await vscode.commands.executeCommand('editor.action.commentLine')
      actual = document.lineAt(position.line).text
      if (actual.includes(expected)) {
        return
      }
      const restore = new vscode.WorkspaceEdit()
      restore.replace(document.uri, document.lineAt(position.line).range, original)
      await vscode.workspace.applyEdit(restore)
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    assert.fail(`${marker} must use ${expected} comments; actual: ${actual}`)
  }
  await assertComment('this.count', '//')
  await complete(content, 'this.')
  await assertComment('<AddressTab', '<!--')
  await complete(content, 'this.')
  await assertComment('.card', '/*')

  list = await complete(content.replace('this.count', '\nvdata\n'), '\nvdata')
  const snippet = list.items.find(item => item.label === 'vdata' && item.insertText instanceof vscode.SnippetString)
  assert.ok(snippet, 'script snippets must work inside the embedded language')
  assert.ok(snippet.insertText.value.includes('return {'))

  list = await complete(content.replace('<div>{{ count }}</div>', '<div>{{  }}</div>'), '<div>{{ ')
  assert.ok(list.items.some(item => item.label === 'count' && item.detail === 'Vue data'),
    'empty interpolation must offer current component members')
  list = await complete(content.replace('<AddressTab :address-params="count" @click="save" />', '<'), '\n  <')
  assert.ok(list.items.some(item => item.label === 'AddressTab' && item.detail === 'Vue component'),
    'typing an opening angle bracket must offer registered component tags')
  list = await complete(content.replace('this.count', "const local = 'this.count'"), "'this.")
  assert.ok(!list.items.some(item => item.detail === 'Vue data'), 'strings must not offer instance members')
  for (const [source, marker] of [
    [content.replace('{{ count }}', '{{ true ? count : 0 }}'), '{{ true ? cou'],
    [content.replace('@click="save"', '@click="() => { return count }"'), 'return cou'],
    [content.replace('this.count', 'return /https?:\\/\\//.test(this.count)'), '/.test(this.cou']
  ]) {
    list = await complete(source, marker)
    assert.ok(list.items.some(item => item.label === 'count' && item.detail === 'Vue data'),
      'review regression: ' + marker)
  }

  const utilsFile = path.join(directory, 'src/config/mUtils.js')
  fs.mkdirSync(path.dirname(utilsFile), { recursive: true })
  fs.writeFileSync(path.join(directory, 'jsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }))
  const utilityText = 'export function sgmCodeF(value) { return value }'
  fs.writeFileSync(utilsFile, utilityText)
  const importSource = content.replace("import AddressTab", "import { sgmCodeF as report } from '@/config/mUtils.js'\nimport AddressTab")
    .replace('this.count', 'report({}); this.count')
  await complete(importSource, 'this.')
  let importedDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
    document.uri, document.positionAt(importSource.indexOf('report({') + 1))
  const utilityDocument = await vscode.workspace.openTextDocument(utilsFile)
  assert.ok(importedDefinitions.some(hit => hit.uri.fsPath === utilsFile &&
    utilityDocument.getText(hit.range) === 'sgmCodeF'), 'aliased utility imports must navigate to their declaration')
  const unsavedUtility = '\n// unsaved utility buffer\n' + utilityText
  const utilityEdit = new vscode.WorkspaceEdit()
  utilityEdit.replace(utilityDocument.uri,
    new vscode.Range(utilityDocument.positionAt(0), utilityDocument.positionAt(utilityDocument.getText().length)), unsavedUtility)
  await vscode.workspace.applyEdit(utilityEdit)
  importedDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
    document.uri, document.positionAt(importSource.indexOf('report({') + 1))
  assert.ok(importedDefinitions.some(hit => hit.uri.fsPath === utilsFile && hit.range.start.line === 2 &&
    utilityDocument.getText(hit.range) === 'sgmCodeF'), 'import targets must use the latest unsaved utility buffer')

  list = await complete(content.replace(':address-params="count"', ':addr'), ':addr')
  assert.ok(list.items.some(item => item.label === 'address-params' && item.detail.startsWith('Vue prop')))
  list = await complete(content.replace(':address-params="count"', ':'), '<AddressTab :')
  assert.ok(list.items.some(item => item.label === 'address-params' && item.detail.startsWith('Vue prop')),
    'a bare binding colon must offer props before a name is typed')
  const child = await vscode.workspace.openTextDocument(childFile)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(child.uri, new vscode.Range(child.positionAt(0), child.positionAt(child.getText().length)),
    `<script>export default { props: ['nextValue'] }</script>`)
  await vscode.workspace.applyEdit(edit)
  list = await complete(content.replace(':address-params="count"', ':next'), ':next')
  assert.ok(list.items.some(item => item.label === 'next-value'), 'unsaved child props must refresh')

  const config = vscode.workspace.getConfiguration('vueClick', document.uri)
  await config.update('completion.enabled', false, vscode.ConfigurationTarget.Workspace)
  list = await complete(content, 'this.')
  assert.ok(!list.items.some(item => item.detail === 'Vue data'))
  await config.update('completion.enabled', true, vscode.ConfigurationTarget.Workspace)
  await config.update('definition.enabled', false, vscode.ConfigurationTarget.Workspace)
  const disabledDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
    document.uri, document.positionAt(document.getText().indexOf('this.count') + 6))
  assert.ok(!disabledDefinitions?.length)
  await config.update('definition.enabled', true, vscode.ConfigurationTarget.Workspace)

  const untitled = await vscode.workspace.openTextDocument({ language: 'vue', content: 'vbase' })
  const rootList = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
    untitled.uri, untitled.positionAt(5))
  assert.ok(rootList.items.some(item => item.label === 'vbase' && item.insertText instanceof vscode.SnippetString))
  const rootEditor = await vscode.window.showTextDocument(untitled)
  const skeleton = rootList.items.find(item => item.label === 'vbase')
  assert.equal(await rootEditor.insertSnippet(skeleton.insertText, skeleton.range), true)
  assert.ok(untitled.getText().startsWith('<template>'))
  assert.ok(untitled.getText().includes("name: 'ComponentName'"))
  assert.ok(!untitled.getText().includes('${'), 'snippet placeholders must expand in the editor')

  const external = new Map()
  for (const installed of vscode.extensions.all) {
    for (const grammar of installed.packageJSON.contributes?.grammars || []) {
      if (grammar.scopeName && grammar.path) {
        external.set(grammar.scopeName, path.join(installed.extensionPath, grammar.path))
      }
    }
  }
  const registry = await grammarRegistry(external)
  try {
    const output = await tokens(registry, content)
    assert.ok(output.some(token => token.text === 'const' || token.text === 'export'))
    assert.ok(output.some(token => token.text === 'export' && token.scopes.some(scope => scope.startsWith('keyword.'))))
    assert.ok(output.some(token => token.text === 'color' && token.scopes.includes('source.css')))
    const typed = await tokens(registry, '<script\n lang="ts">\nconst amount: number = 1\n</script>')
    assert.ok(typed.some(token => token.text === 'number' && token.scopes.includes('source.ts') &&
      token.scopes.some(scope => scope.startsWith('support.type') || scope.startsWith('storage.type'))))
    const dynamic = await tokens(registry, '<template><div :[name]="count + 1" @[event]="save()" /></template>')
    for (const name of ['count', 'save']) {
      assert.ok(dynamic.some(token => token.text === name && token.scopes.includes('source.directive.vue')),
        'dynamic directive expression must retain JS tokens: ' + name)
    }
  } finally {
    registry.dispose()
  }
  if (process.env.VUECLICK_TEST_FILE) {
    await checkRealFile(process.env.VUECLICK_TEST_FILE, external)
  }
  try {
    await require('./advanced').runAdvanced(directory)
  } catch (error) {
    console.log('Advanced Vue2 integration failure: ' + (error.stack || error))
    throw error
  }
  console.log(`VueClick extension-host checks passed on VS Code ${vscode.version}`)
}

async function checkRealFile(file, grammars) {
  const { buildIndex, findDefinition, componentMembers } = require('../../src/resolver')
  const { completionContext } = require('../../src/completion')
  const { findComponentDefinition } = require('../../src/components')
  const { createModuleResolver } = require('../../src/module-paths')
  const hash = text => createHash('sha256').update(text).digest('hex')
  const before = fs.readFileSync(file, 'utf8')
  const expectedHash = hash(before)
  const index = buildIndex(before, 'vue', file)
  const started = performance.now()
  const document = await vscode.workspace.openTextDocument(file)
  await vscode.window.showTextDocument(document)
  assert.equal(document.languageId, 'vue')
  const openMs = performance.now() - started
  const definitions = []
  for (const expression of index.templates) {
    for (const match of before.slice(expression.start, expression.end).matchAll(/[$\p{ID_Start}][$\p{ID_Continue}]*/gu)) {
      const offset = expression.start + match.index
      const hit = findDefinition(index, offset)
      if (hit) {
        definitions.push({ offset, hit })
        break
      }
    }
  }
  assert.ok(definitions.length, 'real file must exercise local definitions')
  function summary(samples) {
    const sorted = samples.sort((a, b) => a - b)
    return { calls: samples.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
      p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3) }
  }
  async function timings(calls, operation) {
    const samples = []
    for (let i = 0; i < calls; i++) {
      const start = performance.now()
      await operation(i)
      samples.push(performance.now() - start)
    }
    return summary(samples)
  }
  const local = await timings(60, async i => {
    const entry = definitions[Math.floor(i * definitions.length / 60)]
    const hits = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
      document.uri, document.positionAt(entry.offset))
    assert.ok(hits.some(hit => hit.uri.fsPath === file && document.offsetAt(hit.range.start) === entry.hit.start))
  })
  const expectedMethod = componentMembers(index).find(item => item.kind === 'method')
  assert.ok(expectedMethod, 'real file must declare component methods')
  const candidateOffsets = [...before.matchAll(/\bthis\./g)].map(match => match.index + 5)
    .filter(offset => completionContext(index, before, offset).items.some(item => item.name === expectedMethod.name))
  assert.ok(candidateOffsets.length, 'real file must exercise instance completions')
  const completion = await timings(60, async i => {
    const offset = candidateOffsets[Math.floor(i * candidateOffsets.length / 60)]
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
      document.uri, document.positionAt(offset))
    assert.ok(list.items.some(item => item.label === expectedMethod.name && item.detail === 'Vue methods'))
  })

  const project = path.resolve(path.dirname(file), '../../..')
  const loaded = new Map([[file, index]])
  const resolve = createModuleResolver({ workspaceRoot: project })
  const context = {
    isCancelled: () => false,
    resolveModule: resolve,
    async loadIndex(target) {
      if (!loaded.has(target)) {
        loaded.set(target, buildIndex(fs.readFileSync(target, 'utf8'), target.endsWith('.vue') ? 'vue' : 'javascript', target))
      }
      return loaded.get(target)
    }
  }
  const props = []
  for (const ref of index.templateReferences.filter(ref => ref.kind === 'prop')) {
    const hit = await findComponentDefinition(index, ref.start, context)
    if (hit && hit.fileName !== file) {
      props.push({ ref, hit })
    }
  }
  assert.ok(props.length, 'real file must exercise cross-file prop definitions')
  const crossFile = await timings(30, async i => {
    const entry = props[Math.floor(i * props.length / 30)]
    const hits = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
      document.uri, document.positionAt(entry.ref.start))
    const target = await vscode.workspace.openTextDocument(entry.hit.fileName)
    assert.ok(hits.some(hit => hit.uri.fsPath === entry.hit.fileName &&
      target.offsetAt(hit.range.start) === entry.hit.start))
  })
  const importReferences = [...before.matchAll(/\bsgmCodeF\b/g)]
  const importTargets = []
  for (const reference of importReferences) {
    const hits = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
      document.uri, document.positionAt(reference.index + 1))
    const expectedFile = path.join(project, 'src/config/mUtils.js')
    const target = await vscode.workspace.openTextDocument(expectedFile)
    const declarationOffset = target.getText().indexOf('export function sgmCodeF') + 'export function '.length
    assert.ok(declarationOffset >= 'export function '.length)
    assert.ok(hits.some(hit => hit.uri.fsPath === expectedFile &&
      target.offsetAt(hit.range.start) === declarationOffset && target.getText(hit.range) === 'sgmCodeF'),
    'every real sgmCodeF reference must resolve to its exported function')
    assert.equal(target.isDirty, false)
    assert.equal(hash(target.getText()), hash(fs.readFileSync(expectedFile, 'utf8')))
    importTargets.push({ sourceLine: document.positionAt(reference.index).line + 1,
      targetLine: target.positionAt(declarationOffset).line + 1 })
  }
  const registry = await grammarRegistry(grammars)
  let grammarMs
  try {
    const start = performance.now()
    const output = await tokens(registry, before)
    grammarMs = performance.now() - start
    assert.ok(output.some(token => token.text === 'export' && token.scopes.includes('source.js')))
    assert.ok(output.some(token => token.scopes.includes('source.css.scss')))
    assert.ok(output.some(token => token.scopes.includes('source.css.less')))
    assert.ok(output.some(token => token.scopes.includes('source.directive.vue')))
  } finally {
    registry.dispose()
  }
  assert.equal(document.isDirty, false, 'real source must remain unedited')
  assert.equal(hash(document.getText()), expectedHash)
  assert.equal(hash(fs.readFileSync(file, 'utf8')), expectedHash)
  console.log('Real-file standalone measurements: ' + JSON.stringify({
    file, vscode: vscode.version, lines: document.lineCount, bytes: Buffer.byteLength(before),
    openMs: +openMs.toFixed(3), local, completion, crossFile,
    fullGrammarMs: +grammarMs.toFixed(3), crossFileProps: props.length, importedFunctionTargets: importTargets, unchanged: true
  }))
}

module.exports = { run }
