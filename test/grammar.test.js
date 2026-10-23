'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { grammarRegistry, tokens } = require('./helpers/grammar')

let registry
test.before(async () => { registry = await grammarRegistry() })
test.after(() => { registry.dispose() })

test('Vue grammar routes inline and multiline SFC blocks to the proper embedded scopes', async () => {
  for (const [opening, scope, marker] of [
    ['<script>', 'source.js', 'const value = 1'],
    ['<script lang="ts">', 'source.ts', 'const value: number = 1'],
    ['<script\n  setup\n  lang = \'ts\'>', 'source.ts', 'const value: number = 1'],
    ['<script lang="tsx">', 'source.tsx', 'const view = <div />'],
    ['<script lang="jsx">', 'source.js.jsx', 'const view = <div />'],
    ['<style scoped>', 'source.css', '.card { color: red }'],
    ['<style\n scoped\n lang="scss">', 'source.css.scss', '$color: red;'],
    ['<style lang=less>', 'source.css.less', '@color: red;']
  ]) {
    const tag = opening.includes('<script') ? 'script' : 'style'
    const output = await tokens(registry, `${opening}${marker}</${tag}>\n<template><div /></template>`)
    assert.ok(output.some(token => token.text.includes(marker) && token.scopes.includes(scope)), opening)
    const div = output.find(token => token.text === 'div')
    assert.ok(div?.scopes.includes('text.html.vueclick'), opening + ' must leave its embedded scope')
    assert.ok(!div.scopes.includes(scope))
  }
})

test('nested template tags keep following markup in Vue HTML and return to script', async () => {
  const output = await tokens(registry, '<template>\n  <template v-if="ready"><span /></template>\n  <AddressTab>{{ count }}</AddressTab>\n</template>\n<script>const ready = true</script>')
  assert.ok(output.some(token => token.text === 'AddressTab' && token.scopes.includes('text.html.vueclick')))
  assert.ok(output.some(token => token.text.includes('count') && token.scopes.includes('expression.embedded.vue')))
  assert.ok(output.some(token => token.text.includes('const ready') && token.scopes.includes('source.js')))
})

test('comments, directives, static strings and interpolation delimiters have distinct scopes', async () => {
  const output = await tokens(registry, '<template><!-- <script>fake</script> --><div title="plain" @click="save">{{ title }}</div></template>')
  assert.ok(output.some(token => token.text.includes('fake') && token.scopes.includes('comment.block.html')))
  assert.ok(output.some(token => token.text === 'plain' && token.scopes.includes('string.quoted.double.html')))
  assert.ok(output.some(token => token.text.includes('save') && token.scopes.includes('source.directive.vue')))
  assert.ok(output.some(token => token.text.includes('title') && token.scopes.includes('expression.embedded.vue')))
})

test('self-closing external blocks and data-lang attributes do not capture subsequent code', async () => {
  const output = await tokens(registry, '<script src="./external.js" />\n<script data-lang="ts">const plain = 1</script>')
  const plain = output.find(token => token.text.includes('const plain'))
  assert.ok(plain.scopes.includes('source.js'))
  assert.ok(!plain.scopes.includes('source.ts'))
})

test('dynamic directive arguments keep their values in JavaScript expression scopes', async () => {
  for (const attribute of [':[name]="count"', '@[event]="count"', 'v-bind:[name]="count"',
    'v-on:[event].stop="count"', ':[name].sync="count"', 'v-slot:[name]="count"', '#[name]="count"',
    ':[keys[index]]="count"']) {
    const output = await tokens(registry, `<template><Child ${attribute} /></template>`)
    const value = output.find(token => token.text.includes('count'))
    assert.ok(value?.scopes.includes('source.directive.vue'), attribute)
    assert.ok(!value.scopes.includes('string.quoted.double.html'), attribute)
  }
  const output = await tokens(registry, '<template><Child title="count" /></template>')
  assert.ok(output.some(token => token.text === 'count' && token.scopes.includes('string.quoted.double.html')))
})
