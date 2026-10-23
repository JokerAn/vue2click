'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Registry, parseRawGrammar, INITIAL } = require('vscode-textmate')
const { loadWASM, OnigScanner, OnigString } = require('vscode-oniguruma')

async function grammarRegistry(external = new Map()) {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'))
  await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))
  const root = path.resolve(__dirname, '../..')
  const paths = new Map(external)
  paths.set('source.vue', path.join(root, 'syntaxes/vue.tmLanguage.json'))
  paths.set('text.html.vueclick', path.join(root, 'syntaxes/vue-html.tmLanguage.json'))
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new OnigScanner(patterns),
      createOnigString: text => new OnigString(text)
    }),
    loadGrammar: async scope => {
      const file = paths.get(scope)
      if (file) {
        return parseRawGrammar(fs.readFileSync(file, 'utf8'), file)
      }
      // Unit tests verify Vue scope routing. The extension-host suite supplies
      // real installed JS/TS/CSS grammars and checks their tokens as well.
      return { scopeName: scope, patterns: [], repository: { expression: { patterns: [] } } }
    }
  })
}

async function tokens(registry, source) {
  const grammar = await registry.loadGrammar('source.vue')
  let state = INITIAL
  const result = []
  for (const line of source.split('\n')) {
    const tokenized = grammar.tokenizeLine(line, state)
    result.push(tokenized.tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes })))
    state = tokenized.ruleStack
  }
  return result.flat()
}

module.exports = { grammarRegistry, tokens }
