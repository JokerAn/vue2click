'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildIndex } = require('../src/resolver')
const { templateDiagnostics } = require('../src/template-diagnostics')

function analyze(text) {
  const index = buildIndex(text, 'vue', '/app/Page.vue')
  const diagnostics = templateDiagnostics(index)
  return { index, diagnostics, names: diagnostics.map(value => text.slice(value.start, value.end)) }
}

const page = (template, script) => `<template>\n${template}\n</template>\n<script>\n${script}\n</script>`

test('undefined template members are reported at their exact source span', () => {
  const text = page('<div><p>{{ missing }}</p><button @click="alsoMissing">x</button></div>',
    'export default { data() { return { known: 1 } }, methods: { present() {} } }')
  const { diagnostics, names } = analyze(text)
  assert.deepEqual(names, ['missing', 'alsoMissing'])
  for (const value of diagnostics) {
    assert.match(value.message, /未在组件中声明/)
  }
})

test('declared members, imports and registered components are never reported', () => {
  const text = page(`<div>
  <span>{{ fromData }} {{ fromComputed }} {{ fromProps }} {{ method() }} {{ imported }}</span>
  <Child :value="fromData" @change="method" />
</div>`,
  `import Child from './Child.vue'
import { imported } from './helper'
export default {
  components: { Child },
  props: ['fromProps'],
  data() { return { fromData: 1 } },
  computed: { fromComputed() { return 1 } },
  methods: { method() {} }
}`)
  assert.deepEqual(analyze(text).names, [])
})

test('template locals, instance members, filters and directive arguments stay silent', () => {
  const text = page(`<div :class="{ active: isActive }" :user-name="isActive">
  <span v-for="(item, index) in rows" :key="index">{{ item.name }}{{ index }}</span>
  <template slot-scope="scope">{{ scope.row }}</template>
  <Child><template v-slot:default="{ user }">{{ user.name }}</template></Child>
  <button @click="e => submit(e)">go</button>
  <button @click="const total = 1; submit(total)">go</button>
  <p>{{ isActive | currency }} {{ $route.path }} {{ $store.state.a }} {{ Math.max(1, 2) }}</p>
  <p>{{ rows.map(row => row.id) }}</p>
</div>`,
  `import Child from './Child.vue'
export default {
  components: { Child },
  data() { return { isActive: true, rows: [] } },
  methods: { submit() {} },
  filters: { currency() {} }
}`)
  assert.deepEqual(analyze(text).names, [])
})

test('dynamic member sources disable the whole check instead of guessing', () => {
  const cases = [
    page('<p>{{ fromMixin }}</p>', 'export default { mixins: [base], data() { return {} } }'),
    page('<p>{{ inherited }}</p>', 'export default { extends: Base, data() { return {} } }'),
    page('<p>{{ x }}</p>', 'export default { data() { return { ...base } } }'),
    page('<p>{{ x }}</p>', 'export default { methods: { ...actions } }'),
    page('<p>{{ x }}</p>', 'export default { computed: { ...mapGetters([\'a\']) }, data() { return {} } }')
  ]
  for (const text of cases) {
    assert.deepEqual(analyze(text).names, [], text)
  }
})

test('script setup and locally built option objects produce no template diagnostics', () => {
  const setup = `<template><p>{{ anything }}</p></template>\n<script setup>\nconst a = 1\n</script>`
  assert.deepEqual(analyze(setup).names, [])
  const shared = page('<p>{{ anything }}</p>', 'const options = { data() { return { x: 1 } } }\nexport default options')
  assert.deepEqual(analyze(shared).names, [])
})

test('the same undefined member is reported once per occurrence, never twice for one span', () => {
  const text = page('<p>{{ absent }}</p><p>{{ absent }}</p>', 'export default { data() { return {} } }')
  const { diagnostics, names } = analyze(text)
  assert.deepEqual(names, ['absent', 'absent'])
  assert.equal(diagnostics.length, 2)
  assert.notEqual(diagnostics[0].start, diagnostics[1].start)
})
