'use strict'

const { doComplete } = require('@vscode/emmet-helper')

function emmetCompletions(entry, position, configuration = {}) {
  if (!entry || !['html', 'css', 'scss', 'less'].includes(entry.language)) {
    return []
  }
  const offset = entry.document.offsetAt(position)
  if (entry.language === 'html') {
    const text = entry.document.getText()
    const node = entry.parsed.findNodeAt(offset)
    const before = text.slice(entry.block.start, offset)
    if ((node && offset < node.startTagEnd) || before.lastIndexOf('<!--') > before.lastIndexOf('-->')) {
      return []
    }
  } else {
    const text = entry.document.getText().slice(entry.block.start, offset)
    if (text.lastIndexOf('/*') > text.lastIndexOf('*/') || /["'][^"']*$/.test(text)) {
      return []
    }
  }
  return doComplete(entry.document, position, entry.language, configuration)?.items || []
}

module.exports = { emmetCompletions }
