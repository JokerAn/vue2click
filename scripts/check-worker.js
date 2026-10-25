'use strict'

const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const path = require('node:path')

async function main() {
  const root = path.dirname(require.resolve('vue/package.json'))
  const fileName = path.join(root, 'vueclick-bundle-proof.vue')
  const text = `<template>{{ amount }}</template><script lang="ts">
const element = document.createElement('div')
const values = [1, 2].map(value => value.toFixed(2))
const promise = Promise.resolve(1)
export default { data() { return { amount: 1 } } }
</script>`
  const worker = new Worker(path.resolve('dist/language-worker.cjs'), {
    workerData: { root, firstFile: fileName, libDirectory: path.resolve('dist/typescript') }
  })
  try {
    let id = 0
    for (const [name, expected] of [
      ['amount', /number/], ['element', /HTMLDivElement/],
      ['values', /string\[\]/], ['promise', /Promise<number>/]
    ]) {
      const result = await new Promise((resolve, reject) => {
        const finish = (error, message) => {
          clearTimeout(timeout)
          worker.off('error', onError)
          worker.off('message', onMessage)
          if (error) reject(error)
          else resolve(message)
        }
        const onError = error => finish(error)
        const onMessage = message => finish(null, message)
        const timeout = setTimeout(() => finish(new Error('Bundled language worker timed out')), 20000)
        worker.once('error', onError)
        worker.once('message', onMessage)
        worker.postMessage({ id: ++id, method: 'quickInfo', fileName, offset: text.indexOf(name),
          documents: [{ fileName, version: 1, text }] })
      })
      assert.ok(!result.error, result.error)
      assert.match(result.result.text, expected)
    }
    console.log('Bundled CommonJS worker resolves Vue2, DOM, Array and Promise types with shipped TypeScript libraries.')
  } finally {
    await worker.terminate()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
