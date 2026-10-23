'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildIndex } = require('../src/resolver')
const { completionContext } = require('../src/completion')

function complete(source, settings) {
  const offset = source.indexOf('|')
  assert.ok(offset >= 0)
  const text = source.replace('|', '')
  const index = buildIndex(text, 'vue', '/workspace/Example.vue')
  return completionContext(index, text, offset, settings)
}

const options = `export default {
  props: ['message'],
  data() { return { count: 0, user: {} } },
  computed: { title() { return '' } },
  methods: { save() {}, edit() { $HERE } }
}`
const vue = (expression, script = options.replace('$HERE', '')) =>
  `<template><div>${expression}</div></template><script>${script}</script>`
const names = result => result.items.map(item => item.name)

test('root, script and attribute snippets stay in their corresponding Vue contexts', () => {
  assert.ok(names(complete('vba|se')).includes('vbase'))
  assert.ok(names(complete('vue|2')).includes('vue2'))
  assert.deepEqual(names(complete('<template>vba|se</template>')), [])
  assert.ok(names(complete('<script>\nexport default {\nvda|ta\n}\n</script>')).includes('vdata'))
  assert.ok(names(complete('<template><div vif| /></template>')).includes('vif'))
  assert.deepEqual(names(complete('<style>\nvda|ta\n</style>')), [])
})

test('script member completion respects this ownership, aliases and arrows', () => {
  for (const expression of ['this.co|unt', 'this.|', 'this?.|', 'const me = this; me.|', '() => this.|']) {
    const result = complete(`<script>${options.replace('$HERE', expression)}</script>`)
    assert.ok(names(result).includes('count'), expression)
    assert.ok(names(result).includes('save'), expression)
  }
  for (const expression of ['user.|', 'const nested = { run() { this.| } }', 'function plain() { this.| }']) {
    assert.deepEqual(names(complete(`<script>${options.replace('$HERE', expression)}</script>`)), [], expression)
  }
})

test('template completion includes component members and scoped loop/slot variables', () => {
  const result = complete(vue('{{ co|unt }}'))
  for (const name of ['count', 'message', 'title', 'save']) {
    assert.ok(names(result).includes(name))
  }
  assert.ok(names(complete(vue('{{ this.| }}'))).includes('count'))
  assert.ok(names(complete(vue('{{ (() => this.|)() }}'))).includes('count'))
  assert.deepEqual(names(complete(vue('{{ user.| }}'))), [])
  assert.deepEqual(names(complete(vue('{{ function () { this.| } }}'))), [])
  const local = complete(`<template><div v-for="(user, index) in users">{{ us|er }}</div></template><script>${options.replace('$HERE', '')}</script>`)
  assert.equal(local.items.find(item => item.name === 'user').kind, 'variable')
  assert.ok(names(local).includes('index'))
  const slot = complete(vue('<template v-slot="{ row }">{{ ro|w }}</template>'))
  assert.ok(slot.items.some(item => item.name === 'row' && item.kind === 'variable'))
})

test('directive and empty interpolation expressions offer members while static text does not', () => {
  for (const template of ['<div @click="sa|ve" />', '<div :title="co|unt" />', '<div>{{ | }}</div>', '<div @click="|" />']) {
    assert.ok(names(complete(`<template>${template}</template><script>${options.replace('$HERE', '')}</script>`)).includes('save'), template)
  }
  for (const expression of ['plain co|unt', '<div title="co|unt" />', '<!-- {{ co|unt }} -->', '<div v-pre>{{ co|unt }}</div>']) {
    assert.deepEqual(names(complete(vue(expression))), [], expression)
  }
})

test('comments, strings, regular expressions and unsupported blocks do not offer code completions', () => {
  for (const expression of ["'this.co|unt'", '"this.co|unt"', '`this.co|unt`', '/this.co|unt/', '// this.co|unt\n', '/* this.co|unt */']) {
    assert.deepEqual(names(complete(`<script>${options.replace('$HERE', expression)}</script>`)), [], expression)
  }
  for (const expression of ["{{ 'co|unt' }}", '{{ /* co|unt */ }}']) {
    assert.deepEqual(names(complete(vue(expression))), [], expression)
  }
  assert.deepEqual(names(complete('<template lang="pug">div(vif|)</template>')), [])
  assert.deepEqual(names(complete('<script lang="coffee">\nvda|ta\n</script>')), [])
  assert.deepEqual(names(complete('<script src="./external.js">\nvda|ta\n</script>')), [])
})

test('registered component tags complete without suggesting undeclared ordinary imports', () => {
  const script = `import AddressTab from './AddressTab.vue'; import Other from './Other.vue';
    export default { components: { AddressTab, 'custom-panel': AddressTab } }`
  const result = complete('<template><Add| /></template><script>' + script + '</script>')
  assert.ok(names(result).includes('AddressTab'))
  assert.ok(names(result).includes('custom-panel'))
  assert.ok(!names(result).includes('Other'))
  assert.ok(names(complete('<template><Add| /></template><script setup>import AddressTab from "./AddressTab.vue"</script>')).includes('AddressTab'))
  assert.ok(names(complete('<template><|</template><script>' + script + '</script>')).includes('AddressTab'))
  assert.deepEqual(names(complete('<template><!-- > <| --></template><script>' + script + '</script>')), [])
  assert.deepEqual(names(complete('<template><div v-pre><|</div></template><script>' + script + '</script>')), [])
})

test('prop context identifies the tag, preserves binding punctuation, and excludes used attributes', () => {
  const result = complete('<template><AddressTab :existing-value="count" :new|Prop /></template>')
  assert.equal(result.props.tag, 'AddressTab')
  assert.equal(result.props.used.has('existing-value'), true)
  assert.equal(result.props.used.has('newProp'), false)
  assert.deepEqual(names(complete('<template><AddressTab title="vif|" /></template>')), [])
  assert.equal(complete('<template><AddressTab @cli| /></template>').props, undefined)
  assert.equal(complete('<template><AddressTab :is="other" :pro| /></template>').props, undefined)
  assert.equal(complete('<template><AddressTab v-bind="other" :pro| /></template>').props, undefined)
  assert.equal(complete('<template><AddressTab :| /></template>').props.tag, 'AddressTab')
  assert.equal(complete('<template><AddressTab v-bind="other" :| /></template>').props, undefined)
})

test('completion settings disable each category and incomplete input stays usable', () => {
  assert.deepEqual(names(complete('vba|se', { snippets: false })), [])
  assert.deepEqual(names(complete(vue('{{ co|unt }}'), { members: false })), [])
  assert.ok(names(complete('<template><div>{{ co|</div></template><script>' + options.replace('$HERE', '') + '</script>')).includes('count'))
  assert.ok(names(complete('<template><Add|</template><script>export default { components: { AddressTab } }</script>')).includes('AddressTab'))
})

test('ternary branches, return and await operands offer members without treating object keys as references', () => {
  for (const expression of ['{{ ready ? co|unt : 0 }}', '{{ ready ? 0 : co|unt }}',
    '<button @click="() => { return co|unt }" />',
    '<button @click="async () => { await sa|ve() }" />',
    '{{ ({ value: co|unt }) }}', '{{ ({ co|unt }) }}']) {
    const expected = expression.includes('sa|ve') ? 'save' : 'count'
    assert.ok(names(complete(vue(expression))).includes(expected), expression)
  }
  for (const expression of ['{{ ({ co|unt: 1 }) }}',
    '{{ ((co|unt) => count) }}', '<button @click="() => { const co|unt = 1 }" />']) {
    assert.deepEqual(names(complete(vue(expression))), [], expression)
  }
  assert.ok(names(complete(vue('<button @click="() => { return | }" />'))).includes('count'))
})

test('regex syntax cannot make subsequent code look like a comment', () => {
  for (const expression of ['return /https?:\\/\\//.test(this.co|unt)', 'return /[/*]/.test(this.co|unt)',
    'return /[//]/.test(this.co|unt)', 'return /x/.test(this.co|unt)']) {
    assert.ok(names(complete(`<script>${options.replace('$HERE', expression)}</script>`)).includes('count'), expression)
  }
  for (const expression of ['return /https?:\\/\\//.test(this.count) // this.co|unt\n',
    'return /[/*]/.test(this.count) /* this.co|unt */', 'return /this.co|unt/',
    '// trailing comment this.co|unt']) {
    assert.deepEqual(names(complete(`<script>${options.replace('$HERE', expression)}</script>`)), [], expression)
  }
  assert.deepEqual(names(complete('<script>export default {} // vda|ta\n</script>')), [])
})
