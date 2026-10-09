'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildIndex, findDefinition } = require('../src/resolver')
const { findComponentDefinition } = require('../src/components')

const parentFile = '/project/src/Parent.vue'
const childFile = '/project/src/AddressTab.vue'
const objectProps = `<script>
export default {
  props: { addressParams: Object, bookTimeData: Object, result: Object, title: String }
}
</script>`

function fixture(parent, child = objectProps, extra = {}) {
  const files = { [parentFile]: parent, [childFile]: child, ...extra }
  const options = {
    async resolveModule(specifier, fromFile) {
      if (!specifier.startsWith('.')) return null
      const base = path.resolve(path.dirname(fromFile), specifier)
      return [base, base + '.vue', base + '.js', base + '.ts', path.join(base, 'index.js')]
        .find(file => Object.hasOwn(files, file)) || null
    },
    async loadIndex(fileName) {
      const text = files[fileName]
      if (typeof text !== 'string') return null
      return buildIndex(text, fileName.endsWith('.vue') ? 'vue' : fileName.endsWith('.ts') ? 'typescript' : 'javascript', fileName)
    },
    isCancelled: () => false
  }
  return { files, options, index: buildIndex(parent, 'vue', parentFile) }
}

function offset(text, reference, name = reference) {
  const start = text.indexOf(reference)
  assert.notEqual(start, -1, 'missing reference: ' + reference)
  const inside = reference.indexOf(name)
  assert.notEqual(inside, -1, 'missing token: ' + name)
  return start + inside + (name.length > 1 ? 1 : 0)
}

async function lookup(f, reference, name) {
  return findComponentDefinition(f.index, offset(f.files[parentFile], reference, name), f.options)
}

function assertTarget(f, hit, expectedFile = childFile) {
  assert.ok(hit, 'expected a cross-file definition')
  assert.equal(hit.fileName, expectedFile)
  assert.ok(Number.isInteger(hit.start) && Number.isInteger(hit.end))
  assert.ok(hit.start >= 0 && hit.end >= hit.start && hit.end <= f.files[expectedFile].length)
}

function assertProp(f, hit, name, expectedFile = childFile) {
  assertTarget(f, hit, expectedFile)
  const text = f.files[expectedFile]
  assert.equal(text.slice(hit.start, hit.end).replace(/^['"]|['"]$/g, ''), name)
  assert.ok(hit.start === text.indexOf(name) || hit.start === text.indexOf(name) - 1, 'must target the prop declaration')
}

test('registered component tags resolve opening, closing and kebab-case spelling', async () => {
  for (const registration of ['AddressTab', 'AddressTab: ImportedTab', "'AddressTab': ImportedTab"]) {
    const imported = registration === 'AddressTab' ? 'AddressTab' : 'ImportedTab'
    const f = fixture(`<template><AddressTab></AddressTab><address-tab /></template>
<script>import ${imported} from './AddressTab.vue'; export default { components: { ${registration} } }</script>`)
    const hits = []
    for (const reference of ['<AddressTab>', '</AddressTab>', '<address-tab']) {
      const hit = await lookup(f, reference, reference.includes('address-tab') ? 'address-tab' : 'AddressTab')
      assertTarget(f, hit)
      hits.push(hit)
    }
    assert.deepEqual(hits[0], hits[1], 'opening and closing tags must identify the same definition')
  }
})

test('prop arguments resolve camel/kebab names, v-bind modifiers and static props', async () => {
  for (const child of [objectProps, `<script>export default { props: ['addressParams', 'bookTimeData', 'result', 'title'] }</script>`]) {
    const f = fixture(`<template>
  <AddressTab :address-params="addressParams" :bookTimeData="bookTimeData"
    v-bind:result.sync="changeResult" title="配送地址" />
</template><script>
import AddressTab from './AddressTab.vue'
export default { components: { AddressTab }, data() { return { addressParams: {}, bookTimeData: {}, changeResult: {} } } }
</script>`, child)
    for (const [reference, name] of [
      [':address-params', 'addressParams'], [':bookTimeData', 'bookTimeData'],
      ['v-bind:result.sync', 'result'], ['title="配送地址"', 'title']
    ]) {
      const token = reference === ':address-params' ? 'address-params' : reference === ':bookTimeData' ? 'bookTimeData' : name
      assertProp(f, await lookup(f, reference, token), name)
    }
  }
})

test('binding values and event handlers still resolve in the parent, with no cross-file lookup', async () => {
  const parent = `<template><AddressTab :address-params="addressParams" :result="changeResult" @ok="gotoPage(1)" /></template>
<script>import AddressTab from './AddressTab.vue'
export default { components: { AddressTab }, data() { return { addressParams: {} } },
  computed: { changeResult() { return {} } }, methods: { gotoPage(type) {} } }
</script>`
  const f = fixture(parent)
  let requests = 0
  f.options.resolveModule = async () => { requests++; throw new Error('value expressions must not resolve a component') }
  for (const [reference, name, declaration] of [
    ['"addressParams"', 'addressParams', 'addressParams: {}'],
    ['"changeResult"', 'changeResult', 'changeResult()'],
    ['gotoPage(1)', 'gotoPage', 'gotoPage(type)']
  ]) {
    const at = offset(parent, reference, name)
    assert.equal(await findComponentDefinition(f.index, at, f.options), null)
    assert.equal(findDefinition(f.index, at)?.start, parent.indexOf(declaration))
  }
  assert.equal(requests, 0)
})

test('ordinary Options imports require registration and unsupported template targets do not jump', async () => {
  const f = fixture(`<template>
  <Unregistered :address-params="value" /><Unknown :result="value" />
  <div :result="value" /><AddressTab :missing="value" :[result]="value" />
  <section v-pre><AddressTab :address-params="literal" /></section>
</template><script>
import Unregistered from './AddressTab.vue'; import AddressTab from './AddressTab.vue'
export default { components: { AddressTab }, data() { return { value: {}, result: 'result' } } }
</script>`)
  for (const [reference, name] of [
    ['<Unregistered', 'Unregistered'], ['<Unknown', 'Unknown'], ['<div', 'div'], ['<div :result', 'result'],
    [':missing', 'missing'], [':[result]', 'result'],
    ['<section v-pre><AddressTab', 'AddressTab'], [':address-params="literal"', 'address-params']
  ]) assert.equal(await lookup(f, reference, name), null, reference)
})

test('script setup imported components resolve without an Options components registration', async () => {
  const f = fixture(`<template><AddressTab :address-params="{}" /></template>
<script setup>import AddressTab from './AddressTab.vue'</script>`)
  assertTarget(f, await lookup(f, '<AddressTab', 'AddressTab'))
  assertProp(f, await lookup(f, ':address-params', 'address-params'), 'addressParams')
})

test('script setup runtime and local TypeScript defineProps declarations are navigable', async () => {
  for (const child of [
    `<script setup>const props = defineProps({ addressParams: Object })</script>`,
    `<script setup>const props = defineProps(['addressParams'])</script>`,
    `<script setup lang="ts">const props = defineProps<{ addressParams?: Record<string, unknown> }>()</script>`,
    `<script setup lang="ts">interface Props { addressParams: object }; const props = defineProps<Props>()</script>`,
    `<script setup lang="ts">type Props = { addressParams: object }; const props = defineProps<Props>()</script>`
  ]) {
    const f = fixture(`<template><AddressTab :address-params="{}" /></template>
<script>import AddressTab from './AddressTab.vue'; export default { components: { AddressTab } }</script>`, child)
    assertProp(f, await lookup(f, ':address-params', 'address-params'), 'addressParams')
  }
})

test('barrel named re-exports and default exports of imported variables reach Vue props', async () => {
  for (const [statement, barrel] of [
    ["import { Foo as AddressTab } from './barrel.js'", "export { default as Foo } from './AddressTab.vue'"],
    ["import AddressTab from './barrel.js'", "import ImportedTab from './AddressTab.vue'; export default ImportedTab"]
  ]) {
    const f = fixture(`<template><AddressTab :result="{}" /></template>
<script>${statement}; export default { components: { AddressTab } }</script>`, objectProps,
    { '/project/src/barrel.js': barrel })
    assertTarget(f, await lookup(f, '<AddressTab', 'AddressTab'))
    assertProp(f, await lookup(f, ':result', 'result'), 'result')
  }
})

test('Vue.extend and defineComponent wrappers expose component registrations and child props', async () => {
  for (const wrapper of ['Vue.extend', 'defineComponent']) {
    const f = fixture(`<template><AddressTab :result="{}" /></template>
<script>import AddressTab from './AddressTab.vue'; export default ${wrapper}({ components: { AddressTab } })</script>`,
    `<script>export default ${wrapper}({ props: { result: Object } })</script>`)
    assertProp(f, await lookup(f, ':result', 'result'), 'result')
  }
})

test('static lazy imports, defineAsyncComponent and require registrations reach component props', async () => {
  for (const expression of [
    "() => import('./AddressTab.vue')",
    "defineAsyncComponent(() => import('./AddressTab.vue'))",
    "require('./AddressTab.vue')"
  ]) {
    for (const [declaration, registration] of [
      [`const AddressTab = ${expression}`, 'AddressTab'], ['', `AddressTab: ${expression}`]
    ]) {
      const f = fixture(`<template><AddressTab :result="{}" /></template>
<script>${declaration}; export default { components: { ${registration} } }</script>`)
      assertTarget(f, await lookup(f, '<AddressTab', 'AddressTab'))
      assertProp(f, await lookup(f, ':result', 'result'), 'result')
    }
  }
})

test('missing modules, re-export cycles and rejected I/O return null without throwing', async () => {
  const parent = `<template><AddressTab :result="{}" /></template>
<script>import AddressTab from './a.js'; export default { components: { AddressTab } }</script>`
  const f = fixture(parent, objectProps, {
    '/project/src/a.js': "export { default } from './b.js'",
    '/project/src/b.js': "export { default } from './a.js'"
  })
  const at = offset(parent, ':result', 'result')
  assert.equal(await findComponentDefinition(f.index, at, f.options), null, 'cycle')
  for (const override of [
    { resolveModule: async () => null },
    { resolveModule: async () => { throw new Error('resolution I/O failure') } },
    { loadIndex: async () => null },
    { loadIndex: async () => { throw new Error('load I/O failure') } }
  ]) assert.equal(await findComponentDefinition(f.index, at, { ...f.options, ...override }), null)
})

test('cancellation before lookup or while loading prevents a definition result', async () => {
  const parent = `<template><AddressTab :result="{}" /></template>
<script>import AddressTab from './AddressTab.vue'; export default { components: { AddressTab } }</script>`
  const f = fixture(parent)
  const at = offset(parent, ':result', 'result')
  let requests = 0
  assert.equal(await findComponentDefinition(f.index, at, { ...f.options,
    isCancelled: () => true, resolveModule: async () => { requests++; return childFile }
  }), null)
  assert.equal(requests, 0)
  let cancelled = false
  assert.equal(await findComponentDefinition(f.index, at, { ...f.options,
    isCancelled: () => cancelled,
    loadIndex: async fileName => { const index = await f.options.loadIndex(fileName); cancelled = true; return index }
  }), null)
})

test('v-model directive names follow Vue 2 default/custom model props and explicit model arguments', async () => {
  for (const [child, name] of [
    [`<script>export default { props: ['value'] }</script>`, 'value'],
    [`<script>export default { model: { prop: 'selected' }, props: ['selected'] }</script>`, 'selected'],
    [`<script setup>defineProps({ modelValue: String })</script>`, 'modelValue']
  ]) {
    const f = fixture(`<template><AddressTab v-model="selection" /></template>
<script>import AddressTab from './AddressTab.vue'; export default { components: { AddressTab } }</script>`, child)
    const hit = await lookup(f, 'v-model')
    assertTarget(f, hit)
    assert.equal(child.slice(hit.start, hit.end).replace(/^['"]|['"]$/g, ''), name)
    assert.equal(hit.start, child.indexOf(name, child.indexOf('props:')) - (child.includes(`['${name}']`) ? 1 : 0))
  }
  const f = fixture(`<template><AddressTab v-model:result="selection" /></template>
<script>import AddressTab from './AddressTab.vue'; export default { components: { AddressTab } }</script>`)
  assertProp(f, await lookup(f, 'v-model:result', 'result'), 'result')
  const unknownModel = fixture(`<template><AddressTab v-model="selection" /></template>
<script>import AddressTab from './AddressTab.vue'; export default { components: { AddressTab } }</script>`,
  `<script>import model from './model.js'; export default { model, props: ['value', 'selected'] }</script>`)
  assert.equal(await lookup(unknownModel, 'v-model'), null)
})

test('dynamic component overrides decline cross-file targets while binding values still resolve locally', async () => {
  for (const attributes of [':is="current"', 'is="Other"', 'v-bind="attrs"', ':[attr]="current"']) {
    const parent = `<template><AddressTab ${attributes} :result="value" /></template>
<script>import AddressTab from './AddressTab.vue'; export default {
 components: { AddressTab }, data() { return { current: null, value: 1 } }
}</script>`
    const f = fixture(parent)
    assert.equal(await lookup(f, '<AddressTab', 'AddressTab'), null, attributes)
    assert.equal(await lookup(f, ':result', 'result'), null, attributes)
    assert.equal(findDefinition(f.index, offset(parent, ':result="value"', 'value'))?.start, parent.indexOf('value: 1'))
  }
})

test('named export-star barrels follow symbols but decline conflicting component definitions', async () => {
  const parent = `<template><AddressTab :result="{}" /></template>
<script>import { Foo as AddressTab } from './barrel.js'; export default { components: { AddressTab } }</script>`
  const extra = { '/project/src/barrel.js': "export * from './one.js'",
    '/project/src/one.js': "export { default as Foo } from './AddressTab.vue'" }
  const f = fixture(parent, objectProps, extra)
  assertProp(f, await lookup(f, ':result', 'result'), 'result')
  const conflict = fixture(parent, objectProps, { ...extra,
    '/project/src/barrel.js': "export * from './one.js'; export * from './two.js'",
    '/project/src/two.js': "export const Foo = { props: { result: Object } }" })
  assert.equal(await lookup(conflict, ':result', 'result'), null)
})

test('real apply-claim AddressTab fixture resolves its prop array at exact source lines', async t => {
  const fileName = '/Users/anshunli1/jd/jdGit/product/web/apply-claim/src/views/apply/index.vue'
  const targetFile = path.join(path.dirname(fileName), 'components/address-tab.vue')
  if (!fs.existsSync(fileName) || !fs.existsSync(targetFile)) return t.skip('original Vue 2 project is not available')
  const { resolveModulePath } = require('../src/module-paths')
  const parent = fs.readFileSync(fileName, 'utf8')
  const child = fs.readFileSync(targetFile, 'utf8')
  const index = buildIndex(parent, 'vue', fileName)
  const options = {
    resolveModule: resolveModulePath,
    async loadIndex(file) {
      return buildIndex(fs.readFileSync(file, 'utf8'), file.endsWith('.vue') ? 'vue' : 'javascript', file)
    },
    isCancelled: () => false
  }
  const tag = await findComponentDefinition(index, offset(parent, '<AddressTab', 'AddressTab'), options)
  assert.equal(tag?.fileName, targetFile)
  for (const [reference, name, line] of [
    [':address-params', 'addressParams', 239], [':bookTimeData', 'bookTimeData', 243]
  ]) {
    const hit = await findComponentDefinition(index, offset(parent, reference, reference.slice(1)), options)
    assert.equal(hit?.fileName, targetFile)
    assert.equal(child.slice(hit.start, hit.end).replace(/^['"]|['"]$/g, ''), name)
    assert.equal(child.slice(0, hit.start).split('\n').length, line)
  }
})
