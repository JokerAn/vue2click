'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { brotliCompressSync } = require('node:zlib')
const { createLibraryReader } = require('../src/typescript-libraries')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-libraries-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'typescript')
  fs.mkdirSync(directory)
  return { root, directory, file: path.join(directory, 'lib.es5.d.ts') }
}

test('packed libraries restore exact text and reuse the existing snapshot cache', t => {
  const { directory, file } = fixture(t)
  const text = '/// <reference lib="es2015" />\r\n/** 中文说明 */\r\ninterface Example { value: string }\r\n'
  fs.writeFileSync(file + '.br', brotliCompressSync(Buffer.from(text)))
  const cache = new Map()
  const reader = createLibraryReader(directory, cache)
  assert.equal(reader.fileExists(file), true)
  assert.equal(cache.size, 0, 'existence checks must not decompress libraries')
  const entry = reader.read(file)
  assert.equal(entry.snapshot.getText(0, entry.snapshot.getLength()), text)
  assert.equal(cache.get(file.replace(/\\/g, '/')), entry)
  fs.unlinkSync(file + '.br')
  assert.equal(reader.read(file), entry, 'cached libraries must not be read or decompressed again')
  assert.equal(reader.fileExists(file), true)
  cache.clear()
  assert.equal(reader.fileExists(file), false)
  assert.equal(reader.read(file), undefined, 'clearing the service cache releases library snapshots')
})

test('packed library lookup stays inside its directory and leaves plain files to normal reads', t => {
  const { root, directory, file } = fixture(t)
  const outside = path.join(root, 'lib.es5.d.ts')
  const nested = path.join(directory, 'nested/lib.es5.d.ts')
  const unrelated = path.join(directory, 'project.d.ts')
  fs.mkdirSync(path.dirname(nested))
  for (const candidate of [outside, nested, unrelated]) {
    fs.writeFileSync(candidate + '.br', brotliCompressSync(Buffer.from('interface Example {}')))
  }
  fs.writeFileSync(file, 'interface PlainLibrary {}')
  const reader = createLibraryReader(directory)
  for (const candidate of [outside, nested, unrelated, file, path.join(directory, 'lib.missing.d.ts')]) {
    assert.equal(reader.fileExists(candidate), false, candidate)
    assert.equal(reader.read(candidate), undefined, candidate)
  }
  const disabled = createLibraryReader()
  assert.equal(disabled.fileExists(outside), false)
  assert.equal(disabled.read(outside), undefined)
})

test('corrupt compressed libraries fail explicitly without poisoning later reads', t => {
  const { directory, file } = fixture(t)
  fs.writeFileSync(file + '.br', 'invalid compressed library')
  const cache = new Map()
  const reader = createLibraryReader(directory, cache)
  assert.equal(reader.fileExists(file), true)
  assert.throws(() => reader.read(file))
  assert.equal(cache.size, 0)
  fs.writeFileSync(file + '.br', brotliCompressSync(Buffer.from('interface Recovered {}')))
  const entry = reader.read(file)
  assert.equal(entry.snapshot.getText(0, entry.snapshot.getLength()), 'interface Recovered {}')
})
