'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ignore = require('ignore')
const ts = require('typescript')

function createProjectFiles(root) {
  root = path.resolve(root)
  const rules = new Map()
  function matcher(directory) {
    if (!rules.has(directory)) {
      let content = ''
      try {
        content = fs.readFileSync(path.join(directory, '.gitignore'), 'utf8')
      } catch {}
      rules.set(directory, ignore().add(content))
    }
    return rules.get(directory)
  }
  function ignored(file, directory = false) {
    const relative = path.relative(root, file).replace(/\\/g, '/')
    if (!relative || relative.startsWith('../')) {
      return false
    }
    if (/(?:^|\/)(?:node_modules|\.git|\.vscode-test)\//.test(relative + '/')) {
      return true
    }
    const pieces = relative.split('/')
    let current = root
    for (let index = 0; index < pieces.length; index++) {
      const candidate = pieces.slice(index).join('/') + (directory ? '/' : '')
      if (matcher(current).ignores(candidate)) {
        return true
      }
      if (index < pieces.length - 1) {
        const child = pieces[index]
        if (matcher(current).ignores(child + '/')) {
          return true
        }
        current = path.join(current, child)
      }
    }
    return false
  }
  function entries(directory) {
    try {
      const files = []
      const directories = []
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(absolute).isDirectory())
        if (!ignored(absolute, isDirectory)) {
          (isDirectory ? directories : files).push(entry.name)
        }
      }
      return { files, directories }
    } catch {
      return { files: [], directories: [] }
    }
  }
  return {
    ignored,
    readDirectory(directory, extensions, excludes, includes, depth) {
      return ts.matchFiles(directory, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames,
        root, depth, entries, ts.sys.realpath)
    }
  }
}

module.exports = { createProjectFiles }
