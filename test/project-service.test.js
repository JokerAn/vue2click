'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createProjectService } = require('../src/project-service')

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-semantic-'))
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.dirname(require.resolve('vue/package.json')), path.join(root, 'node_modules/vue'), 'dir')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, allowJs: true, checkJs: true, types: [], target: 'es2020', module: 'esnext', moduleResolution: 'node' },
    include: ['**/*.vue', '**/*.ts', '**/*.js']
  }))
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), text)
  }
  const file = path.join(root, 'Parent.vue')
  const service = createProjectService(root, file)
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  service.sync([{ fileName: file, version: 1, text: files['Parent.vue'] }])
  return { root, file, service }
}

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
