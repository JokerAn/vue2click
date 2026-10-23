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

  terminate() {}
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
