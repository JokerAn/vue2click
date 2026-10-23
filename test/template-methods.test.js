'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { buildIndex } = require('../src/resolver')
const { templateMethod } = require('../src/template-methods')

function generate(text, options) {
  const marker = text.indexOf('|')
  text = text.replace('|', '')
  const index = buildIndex(text, 'vue', '/app/Page.vue')
  return { text, result: templateMethod(index, marker, options) }
}

function apply(text, result) {
  assert.ok(result)
  for (const edit of [...result.changes[0].textChanges].sort((a, b) => b.span.start - a.span.start)) {
    text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length)
  }
  assert.equal(buildIndex(text, 'vue', '/app/Page.vue').root.parseDiagnostics.length, 0, text)
  return text
}

test('an event call generates a method with parameter names and an existing method separator', () => {
  const { text, result } = generate(`<template><button @click.stop="sub|mit(row, row, $event)" /></template>
<script>export default { methods: { existing() {} // keep this comment
} }</script>`)
  assert.equal(result.name, 'submit')
  assert.match(apply(text, result), /existing\(\) \{\}, \/\/ keep this comment/)
  assert.match(apply(text, result), /submit\(row, row2, event\)/)
})

test('a handler reference creates a methods option and accepts event payloads', () => {
  const { text, result } = generate('<template><button v-on:click="sub|mit" /></template><script>export default { data() { return {} } }</script>')
  assert.match(apply(text, result), /methods: \{[\s\S]*submit\(\.\.\.args\)/)
})

test('TypeScript parameters are unknown and CRLF and tab options are preserved', () => {
  const { text, result } = generate('<template><button @click="sub|mit(row.id)" /></template>\r\n<script lang="ts">export default {}</script>',
    { insertSpaces: false, tabSize: 4 })
  const updated = apply(text, result)
  assert.match(updated, /\r\n\tmethods: \{/)
  assert.match(updated, /submit\(arg1: unknown\)/)
  assert.ok(!/(?<!\r)\n/.test(updated))
})

test('inserting into methods preserves trailing commas and the closing line', () => {
  const { text, result } = generate(`<template><button @click="sub|mit()" /></template><script>
export default {
  methods: {
    existing() {}, // keep this comment
  }
}</script>`)
  const updated = apply(text, result)
  assert.match(updated, /submit\(\)/)
  assert.ok(!/,\s*,/.test(updated))
  assert.equal((updated.match(/existing/g) || []).length, 1)
})

test('parameter names are valid in strict modules even when argument identifiers are reserved bindings', () => {
  for (const lang of ['', ' lang="ts"']) {
    for (const name of ['arguments', 'eval', 'yield', 'let', 'static', 'implements', 'interface']) {
      const { text, result } = generate(`<template><button @click="sub|mit(${name})" /></template><script${lang}>export default {}</script>`)
      const updated = apply(text, result)
      assert.match(updated, /submit\(arg1(?:: unknown)?\)/)
      const source = buildIndex(updated, 'vue', '/app/Page.vue').source
      const js = lang ? ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext } }).outputText : source
      assert.doesNotThrow(() => new Function('"use strict";\n' + js.replace('export default', 'return')))
    }
  }
})

test('known local members, imports, browser globals and template locals have no generation action', () => {
  for (const [template, script] of [
    ['<button @click="sub|mit()" />', 'export default { methods: { submit() {} } }'],
    ['<button @click="sub|mit()" />', 'export default { data() { return { submit: null } } }'],
    ['<button @click="sub|mit()" />', "import { submit } from './utils'; export default {}"],
    ['<button @click="al|ert(1)" />', 'export default {}'],
    ['<button v-for="submit in rows" @click="sub|mit()" />', 'export default {}'],
    ['<button @click="$em|it(1)" />', 'export default {}']
  ]) {
    assert.equal(generate(`<template>${template}</template><script>${script}</script>`).result, null, template)
  }
})

test('generation is restricted to direct event handlers in an inline Options API component', () => {
  for (const text of [
    '<template><div :title="sub|mit()" /></template><script>export default {}</script>',
    '<template>{{ sub|mit() }}</template><script>export default {}</script>',
    '<template><!-- <button @click="sub|mit()" /> --></template><script>export default {}</script>',
    '<template><div v-pre><button @click="sub|mit()" /></div></template><script>export default {}</script>',
    '<template><button @click="ready && sub|mit()" /></template><script>export default {}</script>',
    '<template><button @click="obj.sub|mit()" /></template><script>export default {}</script>',
    '<template><button @click="sub|mit(...rows)" /></template><script>export default {}</script>',
    '<template><button @click="sub|mit()" /></template><script setup>const x = 1</script>',
    '<template><button @click="sub|mit()" /></template><script>const options = {}; export default options</script>',
    '<template><button @click="sub|mit()" /></template><script>export default { ...external }</script>',
    '<template><button @click="sub|mit()" /></template><script>export default { mixins: [external] }</script>',
    '<template><button @click="sub|mit()" /></template><script>export default { methods: external }</script>',
    '<template><button @click="sub|mit()" /></template><script>export default { methods: { ...external } }</script>',
    '<template><button @click="sub|mit()" /></template><script>const Base = Vue.extend({methods:{submit(){}}}); export default Base.extend({})</script>',
    '<template><button @click="sub|mit()" /></template><script>const fields = ["submit"]; export default {props: fields}</script>',
    '<template><button @click="sub|mit()" /></template><script>const fields = {submit(){}}; export default {computed: fields}</script>',
    '<template><button @click="sub|mit()" /></template><script>const fields = {submit: null}; export default {data(){ return fields }}</script>',
    '<template><button @click="sub|mit()" /></template><script>export default {data(){ return {...fields} }}</script>'
  ]) {
    assert.equal(generate(text).result, null, text)
  }
})
