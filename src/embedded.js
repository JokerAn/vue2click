'use strict'

const fs = require('node:fs')
const { fileURLToPath } = require('node:url')
const fileSystemProvider = {
  async stat(uri) {
    try {
      const stat = await fs.promises.stat(fileURLToPath(uri))
      return { type: stat.isDirectory() ? 2 : 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }
    } catch {
      return { type: 0, ctime: -1, mtime: -1, size: -1 }
    }
  },
  async readDirectory(uri) {
    try {
      return (await fs.promises.readdir(fileURLToPath(uri), { withFileTypes: true }))
        .map(entry => [entry.name, entry.isDirectory() ? 2 : 1])
    } catch {
      return []
    }
  }
}
const html = require('vscode-html-languageservice').getLanguageService({ fileSystemProvider })
const css = require('vscode-css-languageservice')
const { TextDocument } = require('vscode-languageserver-textdocument')
const styles = {
  css: css.getCSSLanguageService({ fileSystemProvider }),
  scss: css.getSCSSLanguageService({ fileSystemProvider }),
  less: css.getLESSLanguageService({ fileSystemProvider })
}

function createEmbeddedService() {
  const cache = new Map()
  function entries(document, index) {
    const key = document.uri.toString()
    let entry = cache.get(key)
    if (!entry || entry.version !== document.version) {
      const text = index.text
      const documents = []
      for (const block of index.blocks) {
        const language = block.tag === 'template' && (!block.lang || block.lang === 'html') ? 'html' :
          block.tag === 'style' ? block.lang || 'css' : undefined
        const service = language === 'html' ? html : styles[language]
        if (!service || block.external) {
          continue
        }
        const chars = text.split('')
        for (let at = 0; at < chars.length; at++) {
          if ((at < block.start || at >= block.end) && chars[at] !== '\r' && chars[at] !== '\n') {
            chars[at] = ' '
          }
        }
        if (language === 'html') {
          // Keep markup and directive names; JS expressions are handled by the Vue service.
          for (const expression of index.templates) {
            for (let at = expression.start; at < expression.end; at++) {
              if (chars[at] !== '\r' && chars[at] !== '\n') {
                chars[at] = ' '
              }
            }
          }
        }
        const virtual = TextDocument.create(key, language, document.version, chars.join(''))
        documents.push({ language, service, document: virtual, block,
          parsed: language === 'html' ? service.parseHTMLDocument(virtual) : service.parseStylesheet(virtual) })
      }
      entry = { version: document.version, documents }
      cache.delete(key)
      cache.set(key, entry)
      while (cache.size > 16) {
        cache.delete(cache.keys().next().value)
      }
    }
    return entry.documents
  }
  return {
    at(document, index, position) {
      const offset = document.offsetAt(position)
      if (index.templates.some(expression => expression.start <= offset && offset <= expression.end)) {
        return undefined
      }
      return entries(document, index).find(entry => offset >= entry.block.start && offset <= entry.block.end)
    },
    entries,
    close: document => cache.delete(document.uri.toString()),
    dispose: () => cache.clear()
  }
}

module.exports = { createEmbeddedService }
