'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildIndex } = require('../src/resolver')
const { createIndirectService } = require('../src/indirect')

function fixture(plugin) {
  const sources = new Map([
    ['/app/plugin.js', plugin],
    ['/app/Child.vue', '<script>export default { methods: { open() {} } }</script>']
  ])
  const loads = []
  const service = createIndirectService(
    () => [...sources.keys()].filter(file => file.endsWith('.js')),
    async file => {
      loads.push(file)
      const text = sources.get(file)
      return text === undefined ? null : buildIndex(text, file.endsWith('.vue') ? 'vue' : 'javascript', file)
    },
    async (specifier, from) => {
      const file = path.resolve(path.dirname(from), specifier)
      return sources.has(file) ? file : null
    })
  async function definitions(expression, template = '') {
    const marker = expression.indexOf('|')
    assert.ok(marker >= 0)
    const text = `<template>${template}</template><script>export default {
      methods: { run() { ${expression.replace('|', '')} } }
    }</script>`
    const offset = text.indexOf(expression.replace('|', '')) + marker
    return service.definitions(buildIndex(text, 'vue', '/app/Parent.vue'), offset)
  }
  return { sources, loads, service, definitions }
}

test('all documented exported plugin forms contribute their first Vue parameter', async () => {
  const body = `V.component('GlobalChild', Child); V.prototype.$notify = () => {}`
  const forms = [
    `export default { install(V, options) { ${body} } }`,
    `export default { install: function(V) { ${body} } }`,
    `const Plugin = { install(V) { ${body} } }; export default Plugin`,
    `const Plugin = {}; Plugin.install = function(V) { ${body} }; export default Plugin`,
    `const Plugin = {}; Plugin.install = (V) => { ${body} }; export default Plugin`,
    `function install(V) { ${body} }; export default { install }`,
    `const install = (V) => { ${body} }; export default { install }`
  ]
  for (const form of forms) {
    const f = fixture(`import Child from './Child.vue'; ${form}`)
    const result = await f.definitions('this.$not|ify()')
    assert.equal(result[0]?.fileName, '/app/plugin.js', form)
    const member = await f.definitions('this.$refs.dialog.op|en()', '<GlobalChild ref="dialog" />')
    assert.equal(member[0]?.fileName, '/app/Child.vue', form)
  }
})

test('unexported install functions, other parameters and shadowed Vue names do not contribute globals', async () => {
  for (const plugin of [
    'function install(Vue) { Vue.prototype.$fake = 1 }',
    'const Other = { install(Vue) { Vue.prototype.$fake = 1 } }; export default {}',
    'export default { install(Vue, options) { options.prototype.$fake = 1 } }',
    `import Vue from 'vue'; export default { install(Vue) {
      { const Vue = {}; Vue.prototype.$fake = 1 }
    } }`,
    `import Vue from 'vue'; { const Vue = {}; Vue.prototype.$fake = 1 }`,
    'const Plugin = {}; Plugin.install = function(Vue) { Vue.prototype.$fake = 1 }; export default {}'
  ]) {
    const f = fixture(plugin)
    assert.deepEqual(await f.definitions('this.$fa|ke'), [], plugin)
  }
})

test('registry only reloads the invalidated file and removes deleted contributions', async () => {
  const f = fixture(`import Vue from 'vue'; Vue.prototype.$old = 1`)
  f.sources.set('/app/plain.js', 'export const value = 1')
  assert.equal((await f.definitions('this.$o|ld'))[0]?.fileName, '/app/plugin.js')
  const initial = f.loads.length
  await f.definitions('this.$o|ld')
  assert.equal(f.loads.length, initial, 'unchanged registry must not reload files')

  f.sources.set('/app/plain.js', 'export const value = 2')
  f.service.invalidate('/app/plain.js')
  await f.definitions('this.$o|ld')
  assert.deepEqual(f.loads.slice(initial), ['/app/plain.js'])

  f.sources.set('/app/plugin.js', `import Vue from 'vue'; Vue.prototype.$new = 1`)
  f.service.invalidate('/app/plugin.js')
  assert.deepEqual(await f.definitions('this.$o|ld'), [])
  assert.equal((await f.definitions('this.$n|ew'))[0]?.fileName, '/app/plugin.js')
  f.sources.delete('/app/plugin.js')
  f.service.invalidate('/app/plugin.js')
  assert.deepEqual(await f.definitions('this.$n|ew'), [])

  f.sources.set('/app/added.js', `import Vue from 'vue'; Vue.prototype.$added = 1`)
  f.service.invalidate('/app/added.js')
  assert.equal((await f.definitions('this.$ad|ded'))[0]?.fileName, '/app/added.js')
})

test('loop refs and foreign this owners do not resolve component instance members', async () => {
  const f = fixture(`import Vue from 'vue'; import Child from './Child.vue'; Vue.component('GlobalChild', Child)`)
  assert.deepEqual(await f.definitions('this.$refs.dialog.op|en()', '<div v-for="row in rows"><GlobalChild ref="dialog" /></div>'), [])
  assert.deepEqual(await f.definitions('const other = { run() { this.$refs["dia|log"] } }', '<GlobalChild ref="dialog" />'), [])
})

test('prototype definitions and completions preserve the registration source', async () => {
  const f = fixture(`import Vue from 'vue'; Vue.prototype.$notify = () => {}`)
  const locations = await f.definitions('this.$not|ify()')
  assert.equal(locations[0]?.sourceKind, 'Vue.prototype')
  const text = '<script>export default { methods: { run() { this.$not } } }</script>'
  const index = buildIndex(text, 'vue', '/app/pages/Page.vue')
  const entries = await f.service.completions(index, text.indexOf('this.$not') + 'this.$not'.length)
  assert.match(entries.find(entry => entry.name === '$notify').detail, /Vue\.prototype.*plugin\.js/)
})
