'use strict'

const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const path = require('node:path')

async function main() {
  const root = path.dirname(require.resolve('vue/package.json'))
  const fileName = path.join(root, 'vueclick-bundle-proof.vue')
  const text = '<template>{{ amount }}</template><script lang="ts">export default { data() { return { amount: 1 } } }</script>'
  const worker = new Worker(path.resolve('dist/language-worker.cjs'), {
    workerData: { root, firstFile: fileName, libDirectory: path.resolve('dist/typescript') }
  })
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bundled language worker timed out')), 20000)
      worker.once('error', error => { clearTimeout(timeout); reject(error) })
      worker.once('message', message => { clearTimeout(timeout); resolve(message) })
      worker.postMessage({ id: 1, method: 'quickInfo', fileName, offset: text.indexOf('amount'),
        documents: [{ fileName, version: 1, text }] })
    })
    assert.ok(!result.error, result.error)
    assert.match(result.result.text, /number/)
    console.log('Bundled CommonJS language worker resolves Vue2 types with shipped TypeScript libraries.')
  } finally {
    await worker.terminate()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
