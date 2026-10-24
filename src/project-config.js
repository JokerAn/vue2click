'use strict'

const fs = require('node:fs')
const path = require('node:path')

function within(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function ancestors(directory, boundary) {
  const result = []
  for (let i = 0; i < 128; i++) {
    result.push(directory)
    if (directory === boundary) break
    const parent = path.dirname(directory)
    if (directory === parent) break
    directory = parent
  }
  return result
}

function* configCandidates(fileName, boundary) {
  const root = boundary && path.isAbsolute(boundary) && within(boundary, fileName) ? path.resolve(boundary) : undefined
  for (const directory of ancestors(path.dirname(fileName), root)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      yield path.join(directory, name)
    }
  }
}

function findNearestConfig(fileName, boundary) {
  for (const file of configCandidates(fileName, boundary)) {
    try { if (fs.statSync(file).isFile()) return file } catch (_) {}
  }
  return undefined
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

module.exports = { within, ancestors, configCandidates, findNearestConfig, fileStamp }
