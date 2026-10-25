'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { brotliDecompressSync } = require('node:zlib')
const ts = require('typescript')

function createLibraryReader(directory, cache = new Map()) {
  const root = directory && path.resolve(directory)
  function libraryFile(file) {
    if (!root || !/^lib.*\.d\.ts$/.test(path.basename(file))) return undefined
    const absolute = path.resolve(file)
    return path.dirname(absolute) === root ? absolute.replace(/\\/g, '/') : undefined
  }
  return {
    fileExists(file) {
      const key = libraryFile(file)
      return Boolean(key && (cache.get(key)?.version === 'bundled' || fs.existsSync(key + '.br')))
    },
    read(file) {
      const key = libraryFile(file)
      if (!key) return undefined
      const cached = cache.get(key)
      if (cached?.version === 'bundled') return cached
      let bytes
      try {
        bytes = fs.readFileSync(key + '.br')
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
      const text = brotliDecompressSync(bytes).toString('utf8')
      const entry = { version: 'bundled', snapshot: ts.ScriptSnapshot.fromString(text) }
      cache.set(key, entry)
      return entry
    }
  }
}

module.exports = { createLibraryReader }
