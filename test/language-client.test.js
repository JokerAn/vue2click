'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLanguageClient } = require('../src/language-client')

class FakeWorker extends EventEmitter {
  static instances = []

  constructor() {
    super()
    this.messages = []
    FakeWorker.instances.push(this)
  }

  postMessage(message) {
    this.messages.push(message)
  }

  terminate() { this.terminated = true }
}

function cancellationToken() {
  let listener
  return {
    isCancellationRequested: false,
    onCancellationRequested(callback) {
      listener = callback
      return { dispose() { listener = undefined } }
    },
    cancel() {
      this.isCancellationRequested = true
      listener?.()
    }
  }
}

test('cancelled requests waiting behind an active worker request are never dispatched', async t => {
  FakeWorker.instances = []
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-language-client-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  const fileName = path.join(root, 'Page.vue')
  let text = '<template>version one</template>'
  const document = {
    fileName,
    version: 1,
    uri: { scheme: 'file', fsPath: fileName, toString: () => 'file://' + fileName },
    getText: () => text,
    offsetAt: position => position,
    update(next) { text = next; this.version++ }
  }
  const vscode = {
    workspace: {
      textDocuments: [document],
      getWorkspaceFolder: () => ({ uri: { fsPath: root } })
    },
    window: { activeTextEditor: { document } }
  }
  const client = createLanguageClient(vscode, { extensionPath: root }, FakeWorker)
  t.after(() => {
    client.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const first = client.request('quickInfo', document, 0)
  const worker = FakeWorker.instances[0]
  const staleToken = cancellationToken()
  document.update('<template>version two</template>')
  const stale = client.request('completion', document, 1, staleToken)
  const latest = client.request('references', document, 2)

  assert.deepEqual(worker.messages.map(message => message.method), ['quickInfo'])
  staleToken.cancel()
  assert.equal(await stale, undefined)

  worker.emit('message', { id: worker.messages[0].id, result: 'hover' })
  assert.equal(await first, undefined, 'a result for an obsolete document version must be discarded')
  assert.deepEqual(worker.messages.map(message => message.method), ['quickInfo', 'references'])
  assert.equal(worker.messages[1].documents[0].text, text, 'the queued request must send the latest unsaved text')

  worker.emit('message', { id: worker.messages[1].id, result: ['reference'] })
  assert.deepEqual(await latest, ['reference'])
})

function lifecycle(t, options) {
  FakeWorker.instances = []
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-language-lifecycle-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  const fileName = path.join(root, 'Page.vue')
  const document = {
    fileName, version: 1,
    uri: { scheme: 'file', fsPath: fileName },
    getText: () => '<script>const unsaved = 1</script>',
    offsetAt: position => position
  }
  const vscode = { workspace: { textDocuments: [document] }, window: { activeTextEditor: { document } } }
  const client = createLanguageClient(vscode, { extensionPath: root }, FakeWorker, options)
  t.after(() => { client.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  return { client, document, vscode }
}

test('status and restart do not start a language worker', t => {
  const { client, document } = lifecycle(t)
  assert.equal(client.status(document).state, 'not-started')
  client.invalidate()
  assert.equal(client.status(document).state, 'not-started')
  assert.equal(FakeWorker.instances.length, 0)
})

test('an idle worker is released and recreated with the current unsaved snapshot', async t => {
  const { client, document } = lifecycle(t, { idleMs: 20 })
  const first = client.request('quickInfo', document, 0)
  const worker = FakeWorker.instances[0]
  worker.emit('message', { id: worker.messages[0].id, result: 'first' })
  assert.equal(await first, 'first')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(worker.terminated, true)
  assert.equal(client.status(document).state, 'not-started')
  const second = client.request('quickInfo', document, 0)
  const next = FakeWorker.instances[1]
  assert.equal(next.messages[0].documents[0].text, document.getText())
  next.emit('message', { id: next.messages[0].id, result: 'second' })
  assert.equal(await second, 'second')
})

test('idle expiry does not terminate a worker serving an interactive request', async t => {
  const { client, document } = lifecycle(t, { idleMs: 10 })
  const request = client.request('completion', document, 0)
  const worker = FakeWorker.instances[0]
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(!worker.terminated)
  assert.equal(client.status(document).state, 'busy')
  worker.emit('message', { id: worker.messages[0].id, result: [] })
  assert.deepEqual(await request, [])
})

test('closing the last project document releases pending requests and the worker', async t => {
  const { client, document } = lifecycle(t)
  const request = client.request('quickInfo', document, 0)
  const worker = FakeWorker.instances[0]
  client.close(document)
  assert.equal(await request, undefined)
  assert.equal(worker.terminated, true)
  assert.equal(client.status(document).state, 'not-started')
})

test('closing another project document does not invalidate this project request', async t => {
  const { client, document, vscode } = lifecycle(t)
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-other-project-'))
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }))
  fs.writeFileSync(path.join(otherRoot, 'package.json'), '{}')
  const fileName = path.join(otherRoot, 'Other.vue')
  const other = { ...document, fileName, uri: { scheme: 'file', fsPath: fileName } }
  vscode.workspace.textDocuments.push(other)
  const request = client.request('completion', document, 0)
  const worker = FakeWorker.instances[0]
  assert.deepEqual(worker.messages[0].documents.map(value => value.fileName), [document.fileName])
  other.isClosed = true
  client.close(other)
  assert.ok(!worker.terminated)
  worker.emit('message', { id: worker.messages[0].id, result: ['current-project'] })
  assert.deepEqual(await request, ['current-project'])
})

test('worker exits reject pending work and an old exit cannot discard its replacement', async t => {
  const { client, document } = lifecycle(t)
  const first = client.request('quickInfo', document, 0)
  const failed = FakeWorker.instances[0]
  const rejected = assert.rejects(first, /exited/)
  failed.emit('exit', 1)
  await rejected
  const nextRequest = client.request('completion', document, 0)
  const next = FakeWorker.instances[1]
  failed.emit('exit', 1)
  assert.equal(client.status(document).state, 'busy')
  next.emit('message', { id: next.messages[0].id, result: [] })
  assert.deepEqual(await nextRequest, [])
})
