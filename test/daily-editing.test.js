'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildIndex } = require('../src/resolver')
const { componentInfo, describeComponent } = require('../src/component-info')
const { componentOptions } = require('../src/components')
const { metadataCompletions, templateContext } = require('../src/template-editing')
const { componentCandidates } = require('../src/component-imports')
const { scriptFolding, scriptSelection, scriptHighlights, scriptFormatting } = require('../src/script-editing')
const { createEmbeddedService } = require('../src/embedded')
const { emmetCompletions } = require('../src/emmet')
const { createLibraryData } = require('../src/library-data')

test('component metadata preserves explicit prop contracts, inherited defaults and static events', async () => {
  const parent = '<template><Child :mode="" @ /></template><script>import Child from "./Child.vue"; export default { components: { Child } }</script>'
  const files = {
    '/app/Parent.vue': parent,
    '/app/Child.vue': `<script lang="ts">import mixin from './mixin.js'; export default { mixins: [mixin], props: {
      /** Dialog mode. */ mode: { type: String as PropType<'create' | 'edit'>, required: true, default: 'create' },
      amount: Number
    }, emits: { /** Saved notification. */ saved(value: string) { return true } },
    methods: { run() { this.$emit('closed'); this.$emit(dynamicName) } } }</script>
    <template><button @click="$emit('selected')" /></template>`,
    '/app/mixin.js': 'export default { props: { inherited: { type: Boolean, default: false } } }'
  }
  const index = buildIndex(parent, 'vue', '/app/Parent.vue')
  const context = {
    resolveModule: async specifier => '/app/' + specifier.slice(2),
    loadIndex: async file => files[file] ? buildIndex(files[file], file.endsWith('.vue') ? 'vue' : 'javascript', file) : null
  }
  const info = await componentInfo(index, 'Child', context)
  const mode = info.props.find(prop => prop.name === 'mode')
  assert.equal(mode.type, "'create' | 'edit'")
  assert.equal(mode.required, true)
  assert.equal(mode.default, "'create'")
  assert.match(mode.documentation, /Dialog mode/)
  assert.deepEqual(mode.values.map(value => value.value), ['create', 'edit'])
  assert.equal(info.props.find(prop => prop.name === 'inherited').default, 'false')
  assert.deepEqual(info.events.map(event => event.name).sort(), ['closed', 'saved', 'selected'])
  const offset = parent.indexOf(':mode="') + ':mode="'.length
  assert.deepEqual(metadataCompletions(index, offset, info).map(item => item.name), ["'create'", "'edit'"])
  const event = metadataCompletions(index, parent.indexOf('@ ') + 1, info)
  assert.ok(event.some(item => item.name === 'saved' && /Saved notification/.test(item.documentation)))
})

test('component metadata follows direct imported type declarations and explicit validator literals', async () => {
  const files = {
    '/app/Parent.vue': `<template><Child /></template><script>import Child from './Child.vue'; export default { components: { Child } }</script>`,
    '/app/Child.vue': `<script setup lang="ts">import type { Props } from './types'; defineProps<Props>()</script>`,
    '/app/types.ts': `export interface Props { /** Item size. */ size?: 'small' | 'large'; mode: 'inline' | 'stacked' }`
  }
  const index = buildIndex(files['/app/Parent.vue'], 'vue', '/app/Parent.vue')
  const resolve = async (specifier, from) => {
    const base = path.resolve(path.dirname(from), specifier)
    return [base, base + '.ts', base + '.vue', path.join(base, 'index.ts')].find(file => Object.hasOwn(files, file)) || null
  }
  const info = await componentInfo(index, 'Child', {
    resolveModule: resolve,
    loadIndex: async file => files[file] ? buildIndex(files[file], file.endsWith('.vue') ? 'vue' : 'typescript', file) : null
  })
  assert.equal(info.props.find(prop => prop.name === 'size').required, false)
  assert.match(info.props.find(prop => prop.name === 'size').documentation, /Item size/)
  assert.deepEqual(info.props.find(prop => prop.name === 'mode').values.map(value => value.value), ['inline', 'stacked'])

  const runtimeFiles = {
    '/app/RuntimeParent.vue': `<template><Runtime /></template><script>import Runtime from './Runtime.vue'; export default { components: { Runtime } }</script>`,
    '/app/Runtime.vue': `<script>export default { props: { size: { type: String, validator: value => ['small', 'large'].includes(value) } } }</script>`
  }
  const runtimeIndex = buildIndex(runtimeFiles['/app/RuntimeParent.vue'], 'vue', '/app/RuntimeParent.vue')
  const runtime = await componentInfo(runtimeIndex, 'Runtime', {
    resolveModule: async (specifier, from) => {
      const base = path.resolve(path.dirname(from), specifier)
      return [base, base + '.vue'].find(file => Object.hasOwn(runtimeFiles, file)) || null
    },
    loadIndex: async file => runtimeFiles[file] ? buildIndex(runtimeFiles[file], 'vue', file) : null
  })
  assert.deepEqual(runtime.props[0].values.map(value => value.value), ['small', 'large'])
})

test('validator literal suggestions only describe a direct positive check of the prop value', async () => {
  for (const [validator, expected] of [
    ["value => ['small', 'large'].includes(value)", ['small', 'large']],
    ["function(value) { return ['small', 'large'].includes(value) }", ['small', 'large']],
    ["value => !['small', 'large'].includes(value)", []],
    ["value => ['small', 'large'].includes(other)", []],
    ["value => ['small', 'large'].includes(value) || value === 'other'", []],
    ["value => { const allowed = ['small', 'large'].includes(value); return !allowed }", []]
  ]) {
    const text = `<script>export default { props: { size: { type: String, validator: ${validator} } } }</script>`
    const index = buildIndex(text, 'vue', '/app/Child.vue')
    const info = await describeComponent(index, componentOptions(index), {})
    assert.deepEqual(info.props[0].values.map(value => value.value), expected, validator)
  }
})

test('template metadata never participates in comments, literal text or dynamic components', () => {
  for (const text of [
    '<template><!-- <Child @ --></template>',
    '<template><div v-pre><Child @ /></div></template>',
    '<template><Child :is="target" @ /></template>',
    '<template><div title="<Child @" /></template>'
  ]) {
    const offset = text.indexOf('@') + 1
    assert.equal(templateContext(buildIndex(text, 'vue', '/app/Parent.vue'), offset), null, text)
  }
})

test('component import edits handle aliases, registration and script setup without overlapping template edits', async () => {
  const text = `<template><Invoice /></template><script>
  const InvoiceDialog = 1
  export default { methods: { run() {} } }
  </script>`
  const index = buildIndex(text, 'vue', '/app/Parent.vue')
  const result = (await componentCandidates(index, ['/app/InvoiceDialog.vue'], 'Invoice'))[0]
  assert.equal(result.name, 'InvoiceDialog2')
  let updated = text
  for (const edit of [...result.changes[0].textChanges].sort((a, b) => b.span.start - a.span.start)) {
    updated = updated.slice(0, edit.span.start) + edit.newText + updated.slice(edit.span.start + edit.span.length)
  }
  assert.match(updated, /import InvoiceDialog2 from '.\/InvoiceDialog.vue'/)
  assert.match(updated, /components: \{ InvoiceDialog2 \}/)
  assert.equal(buildIndex(updated, 'vue').root.parseDiagnostics.length, 0)
  const setup = buildIndex('<script setup>const x = 1</script>', 'vue', '/app/Parent.vue')
  assert.equal((await componentCandidates(setup, ['/app/Child.vue'], 'Child'))[0].changes[0].textChanges.length, 1)
  const dynamic = buildIndex('<script>export default { components: { ...external } }</script>', 'vue', '/app/Parent.vue')
  assert.deepEqual(await componentCandidates(dynamic, ['/app/Child.vue'], 'Child'), [])
  const existing = buildIndex(`<template><InvoiceDialog /></template><script>import Invoice from './InvoiceDialog'; export default { components: { Invoice } }</script>`, 'vue', '/app/Parent.vue')
  const existingCandidate = await componentCandidates(existing, ['/app/InvoiceDialog.vue'], 'Invoice',
    async () => '/app/InvoiceDialog.vue')
  assert.deepEqual(existingCandidate, [], 'an already imported and registered component needs no action')
})

test('component imports avoid names already registered as aliases', async () => {
  for (const registeredName of ['Child', "'child'"]) {
    const text = `<template><Child /></template><script>
import Existing from './Existing.vue'
export default { components: { ${registeredName}: Existing } }
</script>`
    const index = buildIndex(text, 'vue', '/app/Parent.vue')
    const candidate = (await componentCandidates(index, ['/app/Child.vue'], 'Child',
      async specifier => path.resolve('/app', specifier)))[0]
    assert.equal(candidate.name, 'Child2')
    let updated = text
    for (const edit of [...candidate.changes[0].textChanges].sort((a, b) => b.span.start - a.span.start)) {
      updated = updated.slice(0, edit.span.start) + edit.newText + updated.slice(edit.span.start + edit.span.length)
    }
    assert.match(updated, /import Child2 from '.\/Child.vue'/)
    assert.match(updated, /(?:Child|'child'):\s*Existing\s*,\s*Child2/)
    assert.equal(buildIndex(updated, 'vue').root.parseDiagnostics.length, 0)
  }
  const imported = `<script>import Child from './Child.vue'; import Existing from './Existing.vue'
export default { components: { Child: Existing } }</script>`
  const candidate = (await componentCandidates(buildIndex(imported, 'vue', '/app/Parent.vue'),
    ['/app/Child.vue'], 'Child', async specifier => path.resolve('/app', specifier)))[0]
  assert.equal(candidate.name, 'Child2')
  assert.equal(candidate.changes[0].textChanges.length, 1)
  assert.match(candidate.changes[0].textChanges[0].newText, /Child2: Child/)
})

test('component registration preserves a trailing comma followed by a comment', async () => {
  const text = `<script>import Existing from './Existing.vue'
export default { components: { Existing, // already registered
} }</script>`
  const candidate = (await componentCandidates(buildIndex(text, 'vue', '/app/Parent.vue'),
    ['/app/Child.vue'], 'Child'))[0]
  let updated = text
  for (const edit of [...candidate.changes[0].textChanges].sort((a, b) => b.span.start - a.span.start)) {
    updated = updated.slice(0, edit.span.start) + edit.newText + updated.slice(edit.span.start + edit.span.length)
  }
  assert.equal(buildIndex(updated, 'vue').root.parseDiagnostics.length, 0)
  assert.match(updated, /Existing, \/\/ already registered\n\s*Child/)
})

test('component values distinguish binding expressions from event handlers and long-form directives', () => {
  for (const directive of [':mode', 'v-bind:mode', ':mode.sync']) {
    const text = `<template><Child ${directive}="form.ship" /></template>`
    const offset = text.indexOf('form.ship') + 'form.ship'.length
    const context = templateContext(buildIndex(text, 'vue', '/app/Parent.vue'), offset)
    assert.equal(context.kind, 'value', directive)
    assert.equal(context.bound, true, directive)
    assert.equal(context.name, 'mode', directive)
  }
  for (const directive of ['@saved', 'v-on:saved', '@saved.once']) {
    const text = `<template><Child ${directive}="form.ship" /></template>`
    const offset = text.indexOf('form.ship') + 'form.ship'.length
    assert.equal(templateContext(buildIndex(text, 'vue', '/app/Parent.vue'), offset), null, directive)
  }
})

test('script-only language features keep source offsets, shadowing and format boundaries', () => {
  const text = `<template><div /></template><script>
const amount=1
function run(amount) {
 return amount+1
}
export default {methods:{go(){return amount}}}
</script><style>.x{color:red}</style>`
  const index = buildIndex(text, 'vue', '/app/Parent.vue')
  const offset = text.indexOf('return amount') + 8
  const highlights = scriptHighlights(index, offset)
  assert.equal(highlights.length, 2)
  assert.ok(highlights.every(value => value.textSpan.start !== text.indexOf('const amount') + 6))
  const selection = scriptSelection(index, offset)
  assert.equal(text.slice(selection.textSpan.start, selection.textSpan.start + selection.textSpan.length), 'amount')
  assert.ok(selection.parent)
  assert.ok(scriptFolding(index).some(value => value.start <= text.indexOf('return amount') && value.end >= text.indexOf('return amount')))
  const edits = scriptFormatting(index, { tabSize: 2, insertSpaces: true })
  assert.ok(edits.length)
  assert.ok(edits.every(value => value.span.start > text.indexOf('<script>') && value.span.start + value.span.length <= text.indexOf('</script>')))
})

test('Emmet expands template and style abbreviations without suggestions in attributes or comments', () => {
  const embedded = createEmbeddedService()
  for (const [text, marker, expected] of [
    ['<template>ul>li*3</template>', 'ul>li*3', true],
    ['<style>.x { m10 }</style>', 'm10', true],
    ['<template><div title="ul>li*3" /></template>', 'ul>li*3', false],
    ['<template><!-- ul>li*3 --></template>', 'ul>li*3', false],
    ['<style>/* m10 */</style>', 'm10', false]
  ]) {
    const index = buildIndex(text, 'vue', '/app/Parent.vue')
    const { TextDocument } = require('vscode-languageserver-textdocument')
    const source = TextDocument.create('file:///app/Parent.vue', 'vue', 1, text)
    const doc = { uri: { toString: () => source.uri }, version: 1,
      positionAt: offset => source.positionAt(offset), offsetAt: position => source.offsetAt(position) }
    const position = doc.positionAt(text.indexOf(marker) + marker.length)
    const entry = embedded.at(doc, index, position)
    assert.equal(emmetCompletions(entry, position).length > 0, expected, text)
    embedded.close(doc)
  }
})

test('library metadata uses installed matching versions and never evaluates packages', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-library-data-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'node_modules/element-ui')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'element-ui': '^2.15.0', 'vue-router': '^3.6.0', missing: '*' } }))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2.15.14', main: 'throw.js', vetur: { tags: 'tags.json', attributes: 'attributes.json' } }))
  fs.writeFileSync(path.join(directory, 'throw.js'), 'throw new Error("must not execute")')
  fs.writeFileSync(path.join(directory, 'tags.json'), JSON.stringify({ 'acme-select': { description: 'Select a value.', attributes: ['tone'] } }))
  fs.writeFileSync(path.join(directory, 'attributes.json'), JSON.stringify({ 'acme-select/tone': { type: 'string', options: ['small', 'mini'] } }))
  fs.mkdirSync(path.join(root, 'node_modules/vue-router'))
  fs.writeFileSync(path.join(root, 'node_modules/vue-router/package.json'), '{"version":"3.6.5"}')
  const data = createLibraryData(root).components()
  assert.equal(data.find(value => value.name === 'acme-select').source, 'element-ui@2.15.14')
  assert.deepEqual(data.find(value => value.name === 'acme-select').props[0].values.map(value => value.value), ['small', 'mini'])
  assert.equal(data.find(value => value.name === 'el-select').source, 'element-ui@2.15.14')
  assert.ok(data.some(value => value.name === 'router-link'))
  const select = data.find(value => value.name === 'el-select')
  assert.ok(select.props.some(value => value.name === 'remote-method'))
  assert.ok(select.events.some(value => value.name === 'visible-change'))
})

test('library metadata reuses reads until a metadata file is invalidated', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-library-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    vetur: { tags: 'tags.json', attributes: 'attributes.json' }
  }))
  fs.writeFileSync(path.join(root, 'tags.json'), JSON.stringify({ 'custom-child': { attributes: ['mode'] } }))
  const attributesFile = path.join(root, 'attributes.json')
  fs.writeFileSync(attributesFile, JSON.stringify({ 'custom-child/mode': { type: 'string', options: ['edit'] } }))
  const originalRead = fs.readFileSync
  let reads = 0
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file).startsWith(root + path.sep)) {
      reads++
    }
    return originalRead.call(this, file, ...args)
  })
  const data = createLibraryData(root)
  assert.equal(data.components()[0].props[0].values[0].value, 'edit')
  const coldReads = reads
  assert.ok(coldReads > 0)
  data.components()
  assert.equal(reads, coldReads, 'unchanged metadata must not reread package manifests or metadata')
  fs.writeFileSync(attributesFile, JSON.stringify({ 'custom-child/mode': { type: 'string', options: ['view'] } }))
  data.invalidate()
  assert.equal(data.components()[0].props[0].values[0].value, 'view')
})
