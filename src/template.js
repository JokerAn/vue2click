'use strict'

const ts = require('typescript')
const { parse, NodeTypes, ErrorCodes } = require('@vue/compiler-dom')
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

function bindingDeclarations(pattern, start) {
  const decoded = expressionSource(pattern, true)
  pattern = decoded.text
  const root = ts.createSourceFile('slot.js', `(${pattern}) => {}`, ts.ScriptTarget.Latest, true)
  const names = []
  function collect(name) {
    if (ts.isIdentifier(name)) {
      names.push([name.text, {
        start: start + decoded.toSource[name.getStart(root) - 1],
        end: start + decoded.toSource[name.end - 1]
      }])
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          collect(element.name)
        }
      }
    }
  }
  const arrow = root.statements[0]?.expression
  if (arrow && ts.isArrowFunction(arrow)) {
    for (const param of arrow.parameters) {
      collect(param.name)
    }
  }
  return names
}

function buildTemplateIndex(text, buildExpressionIndex) {
  const expressions = []
  const references = []
  const blocks = []
  const blockSources = []
  const tags = []
  const texts = []
  // Identical expressions use the same syntax tree within this document
  // version. Their Vue offsets and template-local scopes remain separate.
  const expressionIndexes = new Map()
  const result = { expressions, references, blocks, blockSources, tags, texts }
  // Recover from unfinished markup while the user is typing.
  let root
  let unfinishedTag = false
  try { root = parse(text, { onError(error) { unfinishedTag ||= error.code === ErrorCodes.EOF_IN_TAG } }) } catch { return result }
  const sourceNodes = [...root.children]
  if (unfinishedTag) {
    const start = text.lastIndexOf('<')
    const opening = text.slice(start)
    const value = /^<style\b/.test(opening) && /\ssrc\s*=\s*(?:"([^"]*)|'([^']*))$/.exec(opening)
    if (value) {
      // Repair only an EOF attribute, and let the parser prove it is top-level.
      try {
        const repaired = parse(text + (value[1] !== undefined ? '"' : "'") + '/>', { onError() {} })
        const node = repaired.children.find(node => node.type === NodeTypes.ELEMENT && node.tag === 'style' && node.loc.start.offset === start)
        if (node) sourceNodes.push(node)
      } catch (_) {}
    }
  }
  for (const node of sourceNodes) {
    if (node.type !== NodeTypes.ELEMENT) {
      continue
    }
    const opening = node.loc.source.match(/^<[\w-]+\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/)
    const source = node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'src')?.value
    if (source) {
      const quoted = /^['"]/.test(source.loc.source)
      const closed = !quoted || text[source.loc.end.offset - 1] === source.loc.source[0]
      const start = source.loc.start.offset + Number(quoted)
      const end = Math.min(text.length, source.loc.end.offset - Number(quoted && closed))
      blockSources.push({ tag: node.tag,
        lang: node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'lang')?.value?.content,
        reference: text.slice(start, end), start, end, closed })
    }
    if (!opening || node.isSelfClosing) {
      continue
    }
    const lang = node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'lang')
    const external = node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'src')
    const close = node.loc.source.lastIndexOf(`</${node.tag}`)
    blocks.push({
      tag: node.tag, lang: lang?.value?.content, external,
      start: node.loc.start.offset + opening[0].length,
      end: close >= opening[0].length ? node.loc.start.offset + close : node.loc.end.offset
    })
  }
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
      locals: new Set(locals.keys()), localDefinitions: locals, prefix: prefix.length,
      get source() { return source ||= expressionSource(raw, attribute) },
      get index() {
        const text = prefix + this.source.text + suffix
        if (!expressionIndexes.has(text)) expressionIndexes.set(text, buildExpressionIndex(text))
        return expressionIndexes.get(text)
      }
    })
  }

  function walk(node, inherited, literal = false, inLoop = false) {
    if (node.type === NodeTypes.INTERPOLATION) {
      const start = node.loc.start.offset + 2
      const end = node.loc.end.offset - 2
      add({ isStatic: false, loc: { start: { offset: start }, end: { offset: end },
        source: text.slice(start, end) } }, inherited, false, false)
      return
    }
    if (node.type === NodeTypes.TEXT && !literal) {
      texts.push({ start: node.loc.start.offset, end: node.loc.end.offset })
      // The compiler represents an unfinished interpolation as plain text.
      // Recover only up to the next tag so suggestions cannot spill into markup.
      const match = /\{\{([^<]*?)$/.exec(node.loc.source.split('<')[0])
      if (match) {
        const start = node.loc.start.offset + match.index + 2
        const end = start + match[1].length
        add({ isStatic: false, loc: { start: { offset: start }, end: { offset: end },
          source: match[1] } }, inherited, false, false)
      }
      return
    }
    if (node.type !== NodeTypes.ELEMENT) return
    inLoop ||= node.props.some(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'for')
    // The compiler removes v-pre from props, so check the raw opening attributes.
    const opening = node.loc.source.match(/^<[\w:.-]+((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*)\/?\s*>/)
    literal ||= Boolean(opening && [...opening[1].matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)]
      .some(match => match[1] === 'v-pre'))
    if (literal) return
    const dynamicProps = node.props.filter(prop =>
      (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'is') ||
      (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' &&
        (!prop.arg || !prop.arg.isStatic || prop.arg.content === 'is')))
    const dynamicComponent = dynamicProps.length > 0
    if (node !== template) {
      tags.push({
        tag: node.tag,
        inLoop,
        // A bare `:` is an unfinished prop name, not an object v-bind.
        dynamic: dynamicProps.some(prop => prop.rawName !== ':' || prop.exp),
        start: node.loc.start.offset,
        end: opening ? node.loc.start.offset + opening[0].length : node.loc.end.offset,
        attributes: node.props.map(prop => ({
          start: prop.loc.start.offset, end: prop.loc.end.offset,
          name: prop.type === NodeTypes.ATTRIBUTE ? prop.name : prop.arg?.content,
          value: prop.type === NodeTypes.ATTRIBUTE ? prop.value?.content : undefined
        }))
      })
    }
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
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'on' && prop.arg?.isStatic) {
          references.push({ kind: 'event', tag: node.tag, name: prop.arg.content,
            start: prop.arg.loc.start.offset, end: prop.arg.loc.end.offset })
        }
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'model' && (!prop.arg || prop.arg.isStatic)) {
          const loc = prop.arg?.loc
          references.push({ kind: 'model', tag: node.tag, name: prop.arg?.content,
            start: loc ? loc.start.offset : prop.loc.start.offset,
            end: loc ? loc.end.offset : prop.loc.start.offset + 'v-model'.length })
        }
      }
    }
    const locals = new Map(inherited)
    for (const prop of node.props) {
      if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'for') {
        const loop = prop.forParseResult
        if (loop) {
          add(loop.source, inherited)
          for (const alias of [loop.value, loop.key, loop.index]) {
            if (alias) {
              for (const [name, declaration] of bindingDeclarations(alias.loc.source, alias.loc.start.offset)) {
                locals.set(name, declaration)
              }
            }
          }
        }
      } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'slot' && prop.exp) {
        for (const [name, declaration] of bindingDeclarations(prop.exp.loc.source, prop.exp.loc.start.offset)) {
          locals.set(name, declaration)
        }
      } else if (prop.type === NodeTypes.ATTRIBUTE && ['slot-scope', 'scope'].includes(prop.name) && prop.value) {
        const quoted = /^["']/.test(prop.value.loc.source)
        const raw = quoted ? prop.value.loc.source.slice(1, -1) : prop.value.loc.source
        for (const [name, declaration] of bindingDeclarations(raw, prop.value.loc.start.offset + Number(quoted))) {
          locals.set(name, declaration)
        }
      }
    }
    for (const prop of node.props) {
      if (prop.type !== NodeTypes.DIRECTIVE) continue
      add(prop.arg, locals)
      if (['for', 'slot'].includes(prop.name)) continue
      const event = prop.name === 'on' && Boolean(prop.arg)
      add(prop.exp, event ? new Map([...locals, ['$event', null]]) : locals, event)
    }
    for (const child of node.children) walk(child, locals, literal, inLoop)
  }
  walk(template, new Map())
  return result
}

module.exports = { buildTemplateIndex }
