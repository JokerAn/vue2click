'use strict'

const ts = require('typescript')
const { parse, NodeTypes } = require('@vue/compiler-dom')
const { EntityDecoder, DecodingMode, htmlDecodeTree } = require('entities/decode')

// Decode HTML entities while retaining both directions of the source offset map.
// For example, the gotoPage after `ready &amp;&amp;` must still use its Vue offset.
function expressionSource(raw, attribute) {
  let text = ''
  const toSource = []
  const fromSource = []
  let decoded = ''
  const decoder = new EntityDecoder(htmlDecodeTree, cp => { decoded += String.fromCodePoint(cp) })
  for (let at = 0; at < raw.length;) {
    let length = 1
    decoded = raw[at]
    if (raw[at] === '&') {
      decoded = ''
      decoder.startEntity(attribute ? DecodingMode.Attribute : DecodingMode.Legacy)
      let consumed = decoder.write(raw, at + 1)
      if (consumed < 0) consumed = decoder.end()
      if (consumed > 0) length = consumed
      else decoded = '&'
    }
    for (let i = 0; i < length; i++) fromSource[at + i] = text.length
    for (let i = 0; i < decoded.length; i++) toSource[text.length + i] = at
    text += decoded
    at += length
  }
  toSource[text.length] = raw.length
  fromSource[raw.length] = text.length
  return { text, toSource, fromSource }
}

function bindingNames(pattern) {
  const root = ts.createSourceFile('slot.js', `(${pattern}) => {}`, ts.ScriptTarget.Latest, true)
  const names = []
  function collect(name) {
    if (ts.isIdentifier(name)) names.push(name.text)
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name)
    }
  }
  const arrow = root.statements[0]?.expression
  if (arrow && ts.isArrowFunction(arrow)) for (const param of arrow.parameters) collect(param.name)
  return names
}

function buildTemplateIndex(text, buildExpressionIndex) {
  const expressions = []
  const references = []
  // Identical expressions use the same syntax tree within this document
  // version. Their Vue offsets and template-local scopes remain separate.
  const expressionIndexes = new Map()
  const result = { expressions, references }
  // Recover from unfinished markup while the user is typing.
  let root
  try { root = parse(text, { onError() {} }) } catch { return result }
  const template = root.children.find(node => node.type === NodeTypes.ELEMENT && node.tag === 'template')
  if (!template || template.props.some(prop => prop.type === NodeTypes.ATTRIBUTE &&
    (prop.name === 'src' || (prop.name === 'lang' && prop.value?.content !== 'html')))) return result

  function add(exp, locals, statements = false, attribute = true) {
    if (!exp || exp.isStatic) return
    const raw = exp.loc.source
    let source
    // Wrapping values distinguishes object expressions from statement blocks.
    const prefix = statements ? '{' : '('
    const suffix = statements ? '\n}' : '\n)'
    expressions.push({ start: exp.loc.start.offset, end: exp.loc.end.offset,
      locals, prefix: prefix.length,
      get source() { return source ||= expressionSource(raw, attribute) },
      get index() {
        const text = prefix + this.source.text + suffix
        if (!expressionIndexes.has(text)) expressionIndexes.set(text, buildExpressionIndex(text))
        return expressionIndexes.get(text)
      }
    })
  }

  function walk(node, inherited, literal = false) {
    if (node.type === NodeTypes.INTERPOLATION) {
      add(node.content, inherited, false, false)
      return
    }
    if (node.type !== NodeTypes.ELEMENT) return
    // The compiler removes v-pre from props, so check the raw opening attributes.
    const opening = node.loc.source.match(/^<[\w:.-]+((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*)\/?\s*>/)
    literal ||= Boolean(opening && [...opening[1].matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)]
      .some(match => match[1] === 'v-pre'))
    if (literal) return
    const dynamicComponent = node.props.some(prop =>
      (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'is') ||
      (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' &&
        (!prop.arg || !prop.arg.isStatic || prop.arg.content === 'is')))
    if (node !== template && !dynamicComponent) {
      references.push({ kind: 'component', tag: node.tag, start: node.loc.start.offset + 1,
        end: node.loc.start.offset + 1 + node.tag.length })
      if (!node.isSelfClosing) {
        const close = node.loc.source.lastIndexOf('</')
        if (close >= 0 && node.loc.source.slice(close).replace(/\s+>/, '>') === `</${node.tag}>`) {
          references.push({ kind: 'component', tag: node.tag, start: node.loc.start.offset + close + 2,
            end: node.loc.start.offset + close + 2 + node.tag.length })
        }
      }
      for (const prop of node.props) {
        let name, loc
        if (prop.type === NodeTypes.ATTRIBUTE && !['ref', 'key', 'slot', 'slot-scope', 'scope'].includes(prop.name)) {
          name = prop.name
          loc = prop.nameLoc
        } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.isStatic &&
          !['ref', 'key', 'slot', 'is'].includes(prop.arg.content)) {
          name = prop.arg.content
          loc = prop.arg.loc
        }
        if (loc) references.push({ kind: 'prop', tag: node.tag, name,
          start: loc.start.offset, end: loc.end.offset })
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'model' && (!prop.arg || prop.arg.isStatic)) {
          const loc = prop.arg?.loc
          references.push({ kind: 'model', tag: node.tag, name: prop.arg?.content,
            start: loc ? loc.start.offset : prop.loc.start.offset,
            end: loc ? loc.end.offset : prop.loc.start.offset + 'v-model'.length })
        }
      }
    }
    const locals = new Set(inherited)
    for (const prop of node.props) {
      if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'for') {
        const loop = prop.forParseResult
        if (loop) {
          add(loop.source, inherited)
          for (const alias of [loop.value, loop.key, loop.index]) {
            if (alias) for (const name of bindingNames(alias.content)) locals.add(name)
          }
        }
      } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'slot' && prop.exp) {
        for (const name of bindingNames(prop.exp.content)) locals.add(name)
      } else if (prop.type === NodeTypes.ATTRIBUTE && ['slot-scope', 'scope'].includes(prop.name) && prop.value) {
        for (const name of bindingNames(prop.value.content)) locals.add(name)
      }
    }
    for (const prop of node.props) {
      if (prop.type !== NodeTypes.DIRECTIVE) continue
      add(prop.arg, locals)
      if (['for', 'slot'].includes(prop.name)) continue
      const event = prop.name === 'on' && Boolean(prop.arg)
      add(prop.exp, event ? new Set([...locals, '$event']) : locals, event)
    }
    for (const child of node.children) walk(child, locals, literal)
  }
  walk(template, new Set())
  return result
}

module.exports = { buildTemplateIndex }
