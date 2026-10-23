'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')

async function main() {
  const fileName = path.resolve(process.argv[2] || '')
  const text = fs.readFileSync(fileName, 'utf8')
  const hash = value => createHash('sha256').update(value).digest('hex')
  const before = hash(text)
  let root = path.dirname(fileName)
  while (!['package.json', 'tsconfig.json', 'jsconfig.json'].some(file => fs.existsSync(path.join(root, file)))) {
    const parent = path.dirname(root)
    if (root === parent) {
      root = path.dirname(fileName)
      break
    }
    root = parent
  }
  const started = performance.now()
  const worker = new Worker(path.resolve('dist/language-worker.cjs'), {
    workerData: { root, firstFile: fileName, libDirectory: path.resolve('dist/typescript') }
  })
  let id = 0
  const pending = new Map()
  worker.on('message', message => {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new Error(message.error))
    } else {
      entry.resolve(message.result)
    }
  })
  worker.on('error', error => {
    for (const entry of pending.values()) {
      entry.reject(error)
    }
    pending.clear()
  })
  function request(method, offset) {
    return new Promise((resolve, reject) => {
      const current = ++id
      pending.set(current, { resolve, reject })
      worker.postMessage({ id: current, method, fileName, offset,
        documents: [{ fileName, version: 1, text: current === 1 ? text : undefined }] })
    })
  }
  try {
    const match = [...text.matchAll(/\bsgmCodeF\s*\(/g)][0]
    const offset = match ? match.index + 2 : text.indexOf('export default')
    const hover = await request('quickInfo', offset)
    const coldMs = performance.now() - started
    const times = []
    for (let index = 0; index < 30; index++) {
      const at = performance.now()
      await request('quickInfo', offset)
      times.push(performance.now() - at)
    }
    const diagnosticStart = performance.now()
    const diagnostics = await request('diagnostics', 0)
    const diagnosticsMs = performance.now() - diagnosticStart
    const stats = await request('stats', 0)
    times.sort((a, b) => a - b)
    if (before !== hash(fs.readFileSync(fileName, 'utf8'))) {
      throw new Error('Business fixture changed')
    }
    console.log(JSON.stringify({
      file: fileName, coldMs: +coldMs.toFixed(3), hover: hover?.text,
      warmHover: { calls: times.length, medianMs: +times[15].toFixed(3), p95Ms: +times[28].toFixed(3) },
      diagnostics: { elapsedMs: +diagnosticsMs.toFixed(3), entries: diagnostics.entries.length },
      workerHeapMB: +(stats.heapUsed / 1024 / 1024).toFixed(2), rootFiles: stats.rootFiles, unchanged: true
    }, null, 2))
  } finally {
    await worker.terminate()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
