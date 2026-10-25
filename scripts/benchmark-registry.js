'use strict'

const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { buildIndex } = require('../src/resolver')
const { createIndirectService } = require('../src/indirect')

async function benchmark(count) {
  const files = new Map(Array.from({ length: count }, (_, index) =>
    [`/synthetic/file-${index}.js`, 'export const value = 1']))
  const plugin = '/synthetic/file-0.js'
  files.set(plugin, `import Vue from 'vue'; Vue.prototype.$target = 1`)
  let loads = 0
  const service = createIndirectService(() => [...files.keys()], async file => {
    loads++
    const source = files.get(file)
    if (!source || !/\b(?:component|prototype|Store)\b/.test(source)) return null
    return buildIndex(source, 'javascript', file)
  }, async () => null)
  const text = '<script>export default { methods: { run() { this.$target } } }</script>'
  const index = buildIndex(text, 'vue', '/synthetic/Page.vue')
  const query = () => service.definitions(index, text.indexOf('$target') + 1)
  async function measure(action) {
    const before = loads
    const start = performance.now()
    await action()
    return { loadCalls: loads - before, elapsedMs: +(performance.now() - start).toFixed(3) }
  }
  const cold = await measure(async () => assert.equal((await query())[0]?.fileName, plugin))
  const unchanged = await measure(query)
  files.set('/synthetic/file-1.js', 'export const value = 2')
  service.invalidate('/synthetic/file-1.js')
  const ordinaryEdit = await measure(query)
  files.set(plugin, `import Vue from 'vue';\n\nVue.prototype.$target = 2`)
  service.invalidate(plugin)
  const pluginEdit = await measure(async () => {
    const hit = (await query())[0]
    assert.equal(hit.textSpan.start, files.get(plugin).indexOf('$target'))
  })
  assert.equal(cold.loadCalls, count)
  assert.equal(unchanged.loadCalls, 0)
  assert.equal(ordinaryEdit.loadCalls, 1)
  assert.equal(pluginEdit.loadCalls, 1)
  service.dispose()
  return { files: count, cold, unchanged, ordinaryEdit, pluginEdit }
}

async function main() {
  const results = []
  for (const count of [2000, 5000, 10000]) results.push(await benchmark(count))
  console.log(JSON.stringify({
    node: process.version,
    scope: 'Synthetic in-memory registry. Load calls model candidate reads; no filesystem, editor, IPC or semantic program is measured. Updating still enumerates filenames and merges contributions.',
    results
  }, null, 2))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
