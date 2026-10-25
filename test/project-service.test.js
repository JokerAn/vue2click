'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { brotliCompressSync } = require('node:zlib')
const { createProjectService } = require('../src/project-service')

function fixture(t, files, entry = 'Parent.vue') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-semantic-'))
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.dirname(require.resolve('vue/package.json')), path.join(root, 'node_modules/vue'), 'dir')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, allowJs: true, checkJs: true, types: [], target: 'es2020', module: 'esnext', moduleResolution: 'node' },
    include: ['**/*.vue', '**/*.ts', '**/*.js']
  }))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  const file = path.join(root, entry)
  const service = createProjectService(root, file)
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  service.sync([{ fileName: file, version: 1, text: files[entry] }])
  return { root, file, service }
}

test('compressed standard libraries follow configured DOM, worker and ESNext references', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-packed-project-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'libraries')
  fs.mkdirSync(directory)
  const source = path.dirname(require.resolve('typescript'))
  for (const name of fs.readdirSync(source).filter(name => /^lib.*\.d\.ts$/.test(name))) {
    fs.writeFileSync(path.join(directory, name + '.br'), brotliCompressSync(fs.readFileSync(path.join(source, name))))
  }
  const file = path.join(root, 'example.ts')
  for (const [lib, text, expected] of [
    [['es2020', 'dom'], "const value = document.createElement('div')", /HTMLDivElement/],
    [['es2020', 'webworker'], 'const value = self', /WorkerGlobalScope/],
    [['esnext', 'dom'], 'const value = Promise.withResolvers<number>()', /PromiseWithResolvers<number>/]
  ]) {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, types: [], target: 'es2020', lib },
      include: ['example.ts']
    }))
    fs.writeFileSync(file, text)
    const service = createProjectService(root, file, directory)
    try {
      service.sync([{ fileName: file, version: 1, text }])
      const diagnostics = await service.run('diagnostics', file, 0)
      assert.deepEqual(diagnostics.entries, [], JSON.stringify(diagnostics))
      assert.deepEqual(diagnostics.config, [])
      const info = await service.run('quickInfo', file, text.indexOf('value'))
      assert.match(info.text, expected)
    } finally {
      service.dispose()
    }
  }
})

test('an inferred non-Git project discovers unopened JS exports and globals while respecting ignores', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-inferred-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const text = '<script>export default { methods: { run() { this.$notify(); formatInv } } }</script>'
  const file = path.join(root, 'Parent.vue')
  const sources = {
    'Parent.vue': text,
    'package.json': '{"name":"inferred-project","private":true}',
    'plugin.js': "import Vue from 'vue'; Vue.prototype.$notify = function () {}",
    'utils.js': 'export function formatInvoice() {}',
    '.gitignore': 'ignored/\n',
    'ignored/plugin.js': "import Vue from 'vue'; Vue.prototype.$notify = function () {}"
  }
  for (const [name, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), source)
  }
  const service = createProjectService(root, file)
  t.after(() => service.dispose())
  service.sync([{ fileName: file, version: 1, text }])
  assert.ok(service.files().includes(path.join(root, 'utils.js')))
  assert.ok(!service.files().includes(path.join(root, 'ignored/plugin.js')))
  const globals = await service.run('indirectDefinitions', file, text.indexOf('$notify') + 1)
  assert.deepEqual(globals.map(entry => entry.fileName), [path.join(root, 'plugin.js')])
  const completion = await service.run('completion', file, text.indexOf('formatInv') + 'formatInv'.length)
  assert.ok(completion.entries.some(entry => entry.name === 'formatInvoice'))
})

test('semantic members use a nearer jsconfig instead of an outer tsconfig', async t => {
  const text = '<script>import { form } from "@src/model"; export default { data() { return { form } }, methods: { run() { this.form. } } }</script>'
  const { root, file, service } = fixture(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@src/*': ['outer/*'] } } }),
    'outer/model.js': 'export const form = { wrongOuterField: 1 }',
    'client/jsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true, baseUrl: '.', paths: { '@src/*': ['src/*'] } } }),
    'client/src/model.js': 'export const form = { correctLocalField: 1 }',
    'client/Parent.vue': text
  }, 'client/Parent.vue')
  const definitions = await service.run('definitions', file, text.indexOf('form') + 1)
  assert.ok(definitions.some(value => value.fileName === path.join(root, 'client/src/model.js')))
  const members = (await service.run('completion', file, text.indexOf('this.form.') + 'this.form.'.length)).entries
  assert.ok(members.some(value => value.name === 'correctLocalField'))
  assert.ok(!members.some(value => value.name === 'wrongOuterField'))
})

test('an inferred workspace does not inherit a config outside its boundary', async t => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-config-boundary-'))
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }))
  const root = path.join(outer, 'workspace')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(outer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@src/*': ['outer/*'] } } }))
  fs.mkdirSync(path.join(outer, 'outer'))
  fs.writeFileSync(path.join(outer, 'outer/model.js'), 'export const model = 1')
  const text = 'import { model } from "@src/model"; model'
  const file = path.join(root, 'Page.js')
  fs.writeFileSync(file, text)
  const service = createProjectService(root, file)
  t.after(() => service.dispose())
  service.sync([{ fileName: file, version: 1, text }])
  const definitions = await service.run('definitions', file, text.lastIndexOf('model') + 1)
  assert.ok(definitions.every(value => !value.fileName.startsWith(path.join(outer, 'outer') + path.sep)))
})

test('slot completions read explicit child payload names and update after unsaved edits', async t => {
  const text = `<template><Child><template #row="{ it }"/></Child></template><script>
import Child from './Child.vue'; export default { components: { Child } }</script>`
  const child = '<template><slot name="row" :item="item" :index="index" /></template><script>export default {}</script>'
  const { root, file, service } = fixture(t, { 'Parent.vue': text, 'Child.vue': child })
  const names = await service.run('slotCompletions', file, text.indexOf('#row') + 2)
  assert.ok(names.some(entry => entry.name === 'row'))
  const props = await service.run('slotCompletions', file, text.indexOf('{ it') + 4)
  assert.deepEqual(props.map(entry => entry.name), ['item', 'index'])
  assert.ok(props.every(entry => entry.detail.endsWith('unknown')))
  service.sync([{ fileName: file, version: 1 }, {
    fileName: path.join(root, 'Child.vue'), version: 1, text: child.replace(':item="item"', ':record="item"')
  }])
  assert.deepEqual((await service.run('slotCompletions', file, text.indexOf('{ it') + 4)).map(entry => entry.name),
    ['record', 'index'])
})

test('missing template methods generate only when no static or semantic member exists', async t => {
  const text = '<template><button @click="submit(row)" /></template><script>export default { data() { return { row: {} } } }</script>'
  const { file, service } = fixture(t, { 'Parent.vue': text })
  const edits = await service.run('createTemplateMethod', file, text.indexOf('submit') + 2)
  assert.ok(edits?.some(change => change.textChanges.some(edit => edit.newText.includes('submit(row)'))))
  const edited = text.replace('return { row: {} }', 'return { row: {}, submit: () => {} }')
  service.sync([{ fileName: file, version: 2, text: edited }])
  assert.equal(await service.run('createTemplateMethod', file, edited.indexOf('submit') + 2), null)
})

test('component contracts are reused and refreshed after an unsaved child edit', async t => {
  const text = `<template><Child :mode="" /></template><script>
import Child from './Child.vue'; export default { components: { Child } }</script>`
  const child = '<script>export default { props: { mode: { type: String, required: true } } }</script>'
  const { root, file, service } = fixture(t, { 'Parent.vue': text, 'Child.vue': child })
  const metadata = require('../src/component-info')
  const original = metadata.componentInfo
  let calls = 0
  t.mock.method(metadata, 'componentInfo', (...args) => { calls++; return original(...args) })
  const position = text.indexOf(':mode') + 2
  assert.match((await service.run('componentHover', file, position)).text, /required/)
  await service.run('templateCompletions', file, text.indexOf(':mode="') + ':mode="'.length)
  await service.run('componentHover', file, position)
  assert.equal(calls, 1, 'repeated queries must not traverse the component again')
  service.sync([{ fileName: file, version: 1 }, {
    fileName: path.join(root, 'Child.vue'), version: 1, text: child.replace('required: true', 'required: false')
  }])
  assert.ok(!(await service.run('componentHover', file, position)).text.includes('required'))
  assert.equal(calls, 2, 'changed child contracts must be reparsed')
})

test('a newly created aliased component refreshes static contract module caches', async t => {
  const text = '<template><Later :mode="" /></template><script>import Later from "@src/Later.vue"; export default { components: { Later } }</script>'
  const { root, file, service } = fixture(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@src/*': ['src/*'] } } }),
    'Parent.vue': text
  })
  const offset = text.indexOf(':mode="') + ':mode="'.length
  assert.ok(!(await service.run('templateCompletions', file, offset)).some(value => value.name === '"edit"'))
  const child = path.join(root, 'src/Later.vue')
  fs.mkdirSync(path.dirname(child))
  fs.writeFileSync(child, '<script>export default { props: { mode: { type: String, validator: value => ["edit", "view"].includes(value) } } }</script>')
  service.invalidate(child, 'create')
  assert.ok((await service.run('templateCompletions', file, offset)).some(value => value.name === '"edit"'))
})

test('project metadata refreshes after its JSON file changes', async t => {
  const text = '<template><custom-child mode="" /></template><script>export default {}</script>'
  const { root, file, service } = fixture(t, {
    'Parent.vue': text,
    'package.json': JSON.stringify({ vetur: { tags: 'tags.json', attributes: 'attributes.json' } }),
    'tags.json': JSON.stringify({ 'custom-child': { attributes: ['mode'] } }),
    'attributes.json': JSON.stringify({ 'custom-child/mode': { type: 'string', options: ['edit'] } })
  })
  const offset = text.indexOf('mode="') + 'mode="'.length
  const items = await service.run('templateCompletions', file, offset)
  assert.deepEqual(items.map(item => item.name), ['edit'])
  const metadata = path.join(root, 'attributes.json')
  fs.writeFileSync(metadata, JSON.stringify({ 'custom-child/mode': { type: 'string', options: ['view'] } }))
  service.invalidate(metadata, 'change')
  assert.deepEqual((await service.run('templateCompletions', file, offset)).map(item => item.name), ['view'])
})

test('library contracts match PascalCase tags and refresh metadata with a non-JSON extension', async t => {
  const text = '<template><CustomChild mode="" @ /></template><script>export default {}</script>'
  const { root, file, service } = fixture(t, {
    'Parent.vue': text,
    'package.json': JSON.stringify({ vetur: { tags: 'tags.data', attributes: 'attributes.data' } }),
    'tags.data': JSON.stringify({ 'custom-child': { attributes: ['mode', 'saved'] } }),
    'attributes.data': JSON.stringify({
      'custom-child/mode': { type: 'string', options: ['edit'] }, 'custom-child/saved': { type: 'event' }
    })
  })
  const value = text.indexOf('mode="') + 'mode="'.length
  assert.deepEqual((await service.run('templateCompletions', file, value)).map(item => item.name), ['edit'])
  assert.ok((await service.run('templateCompletions', file, text.indexOf('@') + 1)).some(item => item.name === 'saved'))
  const metadata = path.join(root, 'attributes.data')
  fs.writeFileSync(metadata, JSON.stringify({ 'custom-child/mode': { type: 'string', options: ['view'] } }))
  service.invalidate(metadata, 'change')
  assert.deepEqual((await service.run('templateCompletions', file, value)).map(item => item.name), ['view'])
})

test('Vue2 semantic service maps types, errors, signatures, references and rename back to source', async t => {
  const text = `<template>{{ count }} {{ unknownValue }}</template><script lang="ts">
  export default {
    data() { return { count: 1 } },
    methods: {
      /** 保存一个名称。 */
      save(name: string, times: number) { return name.repeat(times) },
      run() { this.save('test', 2); this.count.toFixed(); this.save(123, 2) }
    }
  }</script>`
  const { file, service } = fixture(t, { 'Parent.vue': text })
  const hover = await service.run('quickInfo', file, text.indexOf('count'))
  assert.match(hover.text, /number/)
  const diagnostics = (await service.run('diagnostics', file, 0)).entries
  assert.ok(diagnostics.some(value => value.code === 2339 && text.slice(value.start, value.start + value.length) === 'unknownValue'))
  assert.ok(diagnostics.some(value => value.code === 2345 && text.slice(value.start, value.start + value.length) === '123'))
  const signature = await service.run('signature', file, text.indexOf("'test',") + 7)
  assert.equal(signature.argument, 1)
  assert.match(signature.items[0].parameters[0].label, /name: string/)
  const references = await service.run('references', file, text.indexOf('count'), { includeDeclaration: true })
  assert.equal(new Set(references.map(value => value.textSpan.start)).size, 3)
  const rename = await service.run('rename', file, text.indexOf('count'), { name: 'total' })
  assert.equal(rename.length, 3)
  assert.ok(rename.every(value => text.slice(value.textSpan.start, value.textSpan.start + value.textSpan.length) === 'count'))
  const edited = text.replace('count: 1', 'count: "changed"')
  service.sync([{ fileName: file, version: 2, text: edited }])
  assert.match((await service.run('quickInfo', file, edited.indexOf('count'))).text, /string/)
})

test('semantic completion resolves an auto import and keeps edits in original Vue source', async t => {
  const text = `<script lang="ts">export default { methods: { run() { formatInv } } }</script>`
  const { file, service } = fixture(t, {
    'Parent.vue': text,
    'utils.ts': '/** 格式化发票。 */ export function formatInvoice(value: string) { return value.trim() }'
  })
  const offset = text.indexOf('formatInv') + 'formatInv'.length
  const completion = await service.run('completion', file, offset)
  const entry = completion.entries.find(value => value.name === 'formatInvoice')
  assert.ok(entry, 'exported functions should appear as auto-import completions')
  const detail = await service.run('completionDetails', file, offset, entry)
  assert.match(detail.documentation, /格式化发票/)
  const edits = detail.actions.flatMap(action => action.changes).flatMap(change => change.textChanges)
  assert.ok(edits.some(edit => /import.*formatInvoice/.test(edit.newText)))
  assert.ok(edits.every(edit => edit.span.start >= text.indexOf('>') + 1 && edit.span.start < text.indexOf('</script>')))
})

test('static fallback tracks mixins, globals, refs, component events and Vuex mappings', async t => {
  const text = `<template><global-child ref="dialog" @saved="run" /></template><script>
    import mixin from './mixin'
    import { mapActions } from 'vuex'
    export default {
      mixins: [mixin], methods: {
        ...mapActions('invoice', { submit: 'save' }),
        run() { this.shared(); this.$notify(); this.$refs.dialog.open(); this.submit(); this.$store.dispatch('invoice/save') }
      }
    }
  </script>`
  const { root, file, service } = fixture(t, {
    'Parent.vue': text,
    'mixin.js': 'export default { methods: { shared() {} } }',
    'Child.vue': `<script>export default { methods: { open() { this.$emit('saved') } } }</script>`,
    'main.js': `import Vue from 'vue'; import Child from './Child.vue'; import Vuex from 'vuex'
      Vue.component('global-child', Child); Vue.prototype.$notify = function() {}
      const store = new Vuex.Store({ modules: { invoice: { namespaced: true, actions: { save() {} } } } })`
  })
  for (const [marker, target, name] of [
    ['this.shared', 'mixin.js', 'shared'],
    ['this.$notify', 'main.js', '$notify'],
    ['dialog.open', 'Child.vue', 'open'],
    ['this.submit', 'main.js', 'save'],
    ['@saved', 'Child.vue', "'saved'"],
    ['invoice/save', 'main.js', 'save']
  ]) {
    const offset = text.indexOf(marker) + (marker.startsWith('this.') ? 6 : marker === 'dialog.open' ? 8 : 2)
    const result = await service.run('indirectDefinitions', file, offset)
    assert.ok(result.length, marker)
    assert.equal(result[0].fileName, path.join(root, target), marker)
    const source = fs.readFileSync(result[0].fileName, 'utf8')
    assert.equal(source.slice(result[0].textSpan.start, result[0].textSpan.start + result[0].textSpan.length), name, marker)
  }
})

test('static fallback resolves string refs and install-scoped Vue globals', async t => {
  const text = `<template><global-child ref="dialog" /></template><script>
    export default { methods: {
      run() { this.$refs["dialog"].open(); this.$notify(); this.$eventBus.$emit('x') }
    } }
  </script>`
  const { root, file, service } = fixture(t, {
    'Parent.vue': text,
    'Child.vue': `<script>export default { methods: { open() {} } }</script>`,
    'plugin.js': `import Vue from 'vue'; import Child from './Child.vue'
      const MyPlugin = {}
      MyPlugin.install = function (Vue) {
        Vue.component('global-child', Child)
        Vue.prototype.$notify = function () {}
        Vue.prototype.$eventBus = new Vue()
      }
      export default MyPlugin`
  })
  for (const [marker, target, name] of [
    ['dialog"].open', 'Child.vue', 'open'],
    ['this.$notify', 'plugin.js', '$notify'],
    ['this.$eventBus', 'plugin.js', '$eventBus']
  ]) {
    const offset = text.indexOf(marker) + (marker.startsWith('dialog') ? marker.indexOf('open') + 1 : marker.indexOf('$'))
    const result = await service.run('indirectDefinitions', file, offset)
    assert.ok(result.length, marker)
    assert.equal(result[0].fileName, path.join(root, target), marker)
    const source = fs.readFileSync(result[0].fileName, 'utf8')
    assert.equal(source.slice(result[0].textSpan.start, result[0].textSpan.start + result[0].textSpan.length), name, marker)
  }
})

test('ordinary functions named install do not create Vue globals', async t => {
  const text = `<script>export default { methods: { run() { this.$fake() } } }</script>`
  const { file, service } = fixture(t, {
    'Parent.vue': text,
    'unrelated.js': `function install(Vue) { Vue.prototype.$fake = function () {} }`
  })
  assert.deepEqual(await service.run('indirectDefinitions', file, text.indexOf('$fake') + 1), [])
})

test('global registrations refresh through unsaved edits, buffer close and filesystem lifecycle', async t => {
  const text = '<script>export default { methods: { run() { this.$old; this.$new; this.$added } } }</script>'
  const plugin = `import Vue from 'vue'; Vue.prototype.$old = 1`
  const scanner = require('../src/global-registry')
  const original = scanner.createGlobalRegistry
  const scans = []
  t.mock.method(scanner, 'createGlobalRegistry', (files, load) =>
    original(files, (file, ...args) => { scans.push(file); return load(file, ...args) }))
  const { file, root, service } = fixture(t, { 'Parent.vue': text, 'plugin.js': plugin })
  const pluginFile = path.join(root, 'plugin.js')
  const query = name => service.run('indirectDefinitions', file, text.indexOf(name) + 1)
  assert.equal((await query('$old'))[0]?.fileName, pluginFile)
  const initialScans = scans.length

  service.sync([{ fileName: file, version: 1 }, {
    fileName: pluginFile, version: 1, text: plugin.replace('$old', '$new')
  }])
  assert.deepEqual(await query('$old'), [])
  assert.equal((await query('$new'))[0]?.fileName, pluginFile)
  assert.deepEqual(scans.slice(initialScans), [pluginFile])

  service.sync([{ fileName: file, version: 1 }])
  assert.equal((await query('$old'))[0]?.fileName, pluginFile, 'closing unsaved buffer restores disk')
  assert.deepEqual(await query('$new'), [])
  fs.writeFileSync(pluginFile, plugin.replace('$old', '$new'))
  service.invalidate(pluginFile, 'change')
  assert.equal((await query('$new'))[0]?.fileName, pluginFile)
  assert.deepEqual(await query('$old'), [])

  fs.unlinkSync(pluginFile)
  service.invalidate(pluginFile, 'delete')
  assert.deepEqual(await query('$new'), [])
  const added = path.join(root, 'added.js')
  fs.writeFileSync(added, `import Vue from 'vue'; Vue.prototype.$added = 1`)
  service.invalidate(added, 'create')
  assert.equal((await query('$added'))[0]?.fileName, added)
})

test('project discovery respects nested gitignore rules and does not include ignored sources', t => {
  const { root, service } = fixture(t, { 'Parent.vue': '<script>export default {}</script>' })
  // Recreate only the service so discovery sees the actual ignore files.
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n')
  fs.mkdirSync(path.join(root, 'ignored'))
  fs.writeFileSync(path.join(root, 'ignored/secret.ts'), 'export const secret = 1')
  fs.mkdirSync(path.join(root, 'visible'))
  fs.writeFileSync(path.join(root, 'visible/.gitignore'), '*.generated.ts\n')
  fs.writeFileSync(path.join(root, 'visible/hidden.generated.ts'), 'export const hidden = 1')
  fs.writeFileSync(path.join(root, 'visible/ordinary.ts'), 'export const ordinary = 1')
  const second = createProjectService(root, path.join(root, 'Parent.vue'))
  t.after(() => second.dispose())
  assert.ok(!second.files().some(file => /secret|hidden/.test(file)))
  assert.ok(second.files().some(file => file.endsWith('/visible/ordinary.ts')))
  assert.ok(service.files().some(file => file.endsWith('/Parent.vue')))
})

test('reference results preserve lexical shadowing across source files and unsaved imports', async t => {
  const text = `<script lang="ts">import { total } from './utils'
    function local(total: string) { return total }
    export default { methods: { run() { return total } } }
  </script>`
  const { file, root, service } = fixture(t, {
    'Parent.vue': text, 'utils.ts': 'export const total = 1',
    'Other.vue': `<script lang="ts">import { total } from './utils'; export default { data() { return { value: total } } }</script>`
  })
  const refs = await service.run('references', file, text.lastIndexOf('total'), { includeDeclaration: true })
  assert.ok(refs.some(value => value.fileName === path.join(root, 'Other.vue')))
  assert.ok(!refs.some(value => value.fileName === file && value.textSpan.start === text.indexOf('return total') + 7))
  await assert.rejects(service.run('rename', file, text.lastIndexOf('total'), { name: 'bad-name' }), /标识符/)
})

test('safe rename rejects reserved words, lexical capture and existing component members', async t => {
  const text = `<script lang="ts">
    const original = 1
    function local() { const captured = 2; return original + captured }
    export default { data() { return { amount: 1, total: 2 } }, methods: { run() { return this.amount } } }
  </script>`
  const { file, service } = fixture(t, { 'Parent.vue': text })
  await assert.rejects(service.run('rename', file, text.indexOf('original'), { name: 'class' }), /标识符/)
  await assert.rejects(service.run('rename', file, text.indexOf('original'), { name: 'await' }), /标识符/)
  await assert.rejects(service.run('rename', file, text.indexOf('original'), { name: 'captured' }), /冲突/)
  await assert.rejects(service.run('rename', file, text.indexOf('this.amount') + 6, { name: 'total' }), /冲突/)
})

test('cross-component props keep kebab casing when renamed from template', async t => {
  const text = `<template><Child :invoice-id="'42'" /></template><script lang="ts">
    import Child from './Child.vue'; export default { components: { Child } }
  </script>`
  const { file, service } = fixture(t, {
    'Parent.vue': text,
    'Child.vue': `<script lang="ts">export default { props: { invoiceId: String } }</script>`
  })
  const result = await service.run('rename', file, text.indexOf('invoice-id') + 2, { name: 'orderId' })
  assert.ok(result.some(value => value.expectedText === 'invoice-id' && value.newName === 'order-id'))
  assert.ok(result.some(value => value.expectedText === 'invoiceId' && value.newName === 'orderId'))
})

test('Vuex state/getter paths, functional mappings and ref completions keep their declared owners', async t => {
  const text = `<template><Child ref="dialog" @saved="run" /></template><script>
    import Child from './Child.vue'
    import { mapState, mapGetters } from 'vuex'
    export default { components: { Child },
      computed: { ...mapState('invoice', { countAlias: state => state.count }), ...mapGetters('invoice', ['amount']) },
      methods: { run() { this.countAlias; this.amount; this.$store.state.invoice.count; this.$store.getters['invoice/amount']; this.$refs.dialog.open } }
    }</script>`
  const { root, file, service } = fixture(t, {
    'Parent.vue': text,
    'Child.vue': `<template><button @click="$emit('saved')" /></template><script>export default { methods: { open() {} } }</script>`,
    'main.js': `import Vuex from 'vuex'; const store = new Vuex.Store({ modules: {
      invoice: { namespaced: true, state: () => ({ count: 1 }), getters: { amount: state => state.count } }
    } })`
  })
  for (const [marker, offset, name] of [
    ['this.countAlias', 7, 'count'], ['this.amount', 7, 'amount'],
    ['invoice.count', 10, 'count'], ["'invoice/amount'", 4, 'amount']
  ]) {
    const result = await service.run('indirectDefinitions', file, text.indexOf(marker) + offset)
    assert.ok(result.length, marker)
    const source = fs.readFileSync(result[0].fileName, 'utf8')
    assert.equal(source.slice(result[0].textSpan.start, result[0].textSpan.start + result[0].textSpan.length), name, marker)
  }
  const event = await service.run('indirectDefinitions', file, text.indexOf('@saved') + 2)
  assert.equal(event[0].fileName, path.join(root, 'Child.vue'))
  const eventSource = fs.readFileSync(event[0].fileName, 'utf8')
  assert.equal(eventSource.slice(event[0].textSpan.start, event[0].textSpan.start + event[0].textSpan.length), "'saved'")
  const completions = await service.run('indirectCompletion', file, text.indexOf('dialog.open') + 'dialog.'.length)
  assert.ok(completions.some(value => value.name === 'open'))
  assert.ok(!completions.some(value => value.name === 'run'))
})

test('creating a previously missing Vue import invalidates the language resolver cache', async t => {
  const text = `<template><Later :amount="'wrong'" /></template><script lang="ts">
    import Later from './Later.vue'; export default { components: { Later } }
  </script>`
  const { root, file, service } = fixture(t, { 'Parent.vue': text })
  const missing = await service.run('diagnostics', file, 0)
  assert.ok(missing.entries.some(value => value.code === 2307))
  const child = path.join(root, 'Later.vue')
  fs.writeFileSync(child, '<script lang="ts">export default { props: { amount: Number } }</script>')
  service.invalidate(child, 'create')
  const found = await service.run('diagnostics', file, 0)
  assert.ok(!found.entries.some(value => value.code === 2307))
  assert.ok(found.entries.some(value => value.code === 2322))
})

test('template candidates include prop contracts, events and component import registration edits', async t => {
  const text = `<template><Child :mode="" @saved="run" /><Invoice /></template><script lang="ts">
import Child from './Child.vue'; export default { components: { Child }, methods: { run() {} } }
</script>`
  const { file, service } = fixture(t, {
    'Parent.vue': text,
    'Child.vue': `<script lang="ts">export default { props: { /** Display mode. */ mode: {
      type: String as PropType<'edit' | 'view'>, default: 'view', required: true } }, emits: ['saved'] }</script>`,
    'InvoiceDialog.vue': '<script>export default {}</script>'
  })
  const values = await service.run('templateCompletions', file, text.indexOf(':mode="') + 7)
  assert.deepEqual(values.map(value => value.name), ["'edit'", "'view'"])
  const hover = await service.run('componentHover', file, text.indexOf(':mode') + 2)
  assert.match(hover.text, /required/)
  assert.match(hover.documentation, /Display mode/)
  const candidates = await service.run('templateCompletions', file, text.indexOf('<Invoice') + 8)
  assert.ok(candidates.some(value => value.name === 'InvoiceDialog' &&
    value.changes[0].textChanges.some(edit => edit.newText.includes('InvoiceDialog.vue'))))
})

test('import fixes and removal map to Vue source and retain imports used by the template', async t => {
  const text = `<template>{{ active }}</template><script lang="ts">
import { unused, active } from './utils'
export default { methods: { run() { return formatInvoice('test') } } }
</script>`
  const { file, service } = fixture(t, {
    'Parent.vue': text,
    'utils.ts': 'export const active = 1; export const unused = 2; export function formatInvoice(value: string) { return value.trim() }'
  })
  await service.run('quickInfo', file, text.indexOf('formatInvoice'))
  const fixes = await service.run('codeFixes', file, text.indexOf('formatInvoice'),
    { end: text.indexOf('formatInvoice') + 13, codes: [2304] })
  assert.ok(fixes.some(fix => fix.changes.some(change => change.textChanges.some(edit => edit.newText.includes('formatInvoice')))))
  const remove = await service.run('organizeImports', file, 0, { mode: 'RemoveUnused' })
  const edits = remove.flatMap(change => change.textChanges)
  assert.ok(edits.length)
  assert.ok(edits.every(edit => edit.span.start >= text.indexOf('<script') && edit.span.start + edit.span.length <= text.indexOf('</script>')))
  let updated = text
  for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    updated = updated.slice(0, edit.span.start) + edit.newText + updated.slice(edit.span.start + edit.span.length)
  }
  assert.match(updated, /import.*active/)
  assert.ok(!/import.*unused/.test(updated))
})

test('installed Element UI 2 metadata supplies component, prop, value and event hints without importing its code', async t => {
  const text = `<template><el-select si /><el-select :size="" @ /></template><script>export default {}</script>`
  const { root, file, service } = fixture(t, { 'Parent.vue': text })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'element-ui': '^2.15.0' } }))
  const element = path.join(root, 'node_modules/element-ui')
  fs.mkdirSync(element, { recursive: true })
  fs.writeFileSync(path.join(element, 'package.json'), '{"version":"2.15.14","main":"throw.js"}')
  fs.writeFileSync(path.join(element, 'throw.js'), 'throw new Error("package code must not execute")')
  const tag = await service.run('templateCompletions', file, text.indexOf('<el-select') + 3)
  assert.ok(tag.some(value => value.name === 'el-select' && value.detail === 'element-ui@2.15.14'))
  const prop = await service.run('templateCompletions', file, text.indexOf('si />') + 2)
  assert.ok(prop.some(value => value.name === 'size'))
  const values = await service.run('templateCompletions', file, text.indexOf(':size="') + 7)
  assert.deepEqual(values.map(value => value.name), ['"medium"', '"small"', '"mini"'])
  const events = await service.run('templateCompletions', file, text.indexOf(' @ />') + 2)
  assert.ok(events.some(value => value.name === 'change' && value.detail === 'change'))
})
