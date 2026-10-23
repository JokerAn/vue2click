'use strict'

const { isHTMLTag, isSVGTag, isMathMLTag } = require('@vue/shared')
const { camel, kebab, propDetail } = require('./component-info')

function templateContext(index, offset) {
  const block = index.blocks.find(block => block.tag === 'template' && !block.external &&
    (!block.lang || block.lang === 'html') && offset >= block.start && offset <= block.end)
  if (!block) {
    return null
  }
  const start = index.text.lastIndexOf('<', offset - 1)
  if (start < block.start) {
    return null
  }
  const before = index.text.slice(start, offset)
  const parsedTag = index.tags.find(tag => offset >= tag.start && offset <= tag.end)
  if (parsedTag && parsedTag.start !== start) {
    return null
  }
  if (!parsedTag && (index.text.slice(block.start, start).lastIndexOf('<!--') >
    index.text.slice(block.start, start).lastIndexOf('-->') ||
    !index.templateTexts.some(node => start >= node.start && start <= node.end))) {
    return null
  }
  if (/^<[\w-]*$/.test(before)) {
    const suffix = /^[\w-]*/.exec(index.text.slice(offset))[0]
    return { kind: 'tag', prefix: before.slice(1), start: start + 1, end: offset + suffix.length }
  }
  const match = /^<([\w-]+)\s/.exec(before)
  if (!match || before.includes('>') || isHTMLTag(match[1]) || isSVGTag(match[1]) || isMathMLTag(match[1])) {
    return null
  }
  if (parsedTag?.dynamic) {
    return null
  }
  const value = /\s((?:v-bind:|v-on:|[:@])?[\w-]+)(?:\.[\w-]+)*\s*=\s*(?:"([^"]*)|'([^']*))$/.exec(before)
  if (value) {
    if (/^(?:@|v-on:)/.test(value[1])) {
      return null
    }
    const content = value[2] ?? value[3]
    const quote = value[2] !== undefined ? '"' : "'"
    const closing = index.text.indexOf(quote, offset)
    return { kind: 'value', tag: match[1], name: value[1].replace(/^(?:v-bind:|:)/, ''), bound: /^(?:v-bind:|:)/.test(value[1]),
      prefix: content, start: offset - content.length, end: closing >= offset ? closing : offset }
  }
  const attribute = /(?:\s|^)(@|v-on:|:|v-bind:)?([\w-]*)$/.exec(before)
  if (!attribute) {
    return null
  }
  return { kind: attribute[1] === '@' || attribute[1] === 'v-on:' ? 'event' : 'prop', tag: match[1],
    prefix: attribute[2], start: offset - attribute[2].length,
    end: offset + /^[\w-]*/.exec(index.text.slice(offset))[0].length }
}

function metadataCompletions(index, offset, info, context = templateContext(index, offset)) {
  if (!context || !info) {
    return []
  }
  const replacementSpan = { start: context.start, length: context.end - context.start }
  if (context.kind === 'value') {
    const prop = info.props.find(prop => camel(prop.name) === camel(context.name))
    return (prop?.values || []).filter(value => context.bound || value.string).map(value => ({
      name: context.bound ? value.text : value.value, kind: 'property', replacementSpan,
      documentation: prop.documentation, detail: propDetail(prop)
    }))
  }
  const entries = context.kind === 'event' ? info.events : info.props
  const tag = index.tags.find(tag => offset >= tag.start && offset <= tag.end)
  const eventPattern = /(?:\s)(?:@|v-on:)([\w-]+)/g
  const rawTag = tag ? index.text.slice(tag.start, tag.end) : ''
  const used = context.kind === 'event'
    ? new Set([...rawTag.matchAll(eventPattern)].filter(match => {
      const end = tag.start + match.index + match[0].length
      const start = end - match[1].length
      return offset < start || offset > end
    }).map(match => match[1]))
    : new Set((tag?.attributes || []).filter(attribute => offset < attribute.start || offset > attribute.end).map(attribute => attribute.name))
  return entries.filter(entry => !used.has(entry.name) && !used.has(kebab(entry.name))).map(entry => ({
    name: context.kind === 'event' ? entry.name : kebab(entry.name), kind: context.kind === 'event' ? 'method' : 'property',
    detail: context.kind === 'event' ? entry.signature || entry.name : propDetail(entry), documentation: entry.documentation,
    replacementSpan
  }))
}

function metadataHover(index, offset, info) {
  const reference = index.templateReferences.find(reference => offset >= reference.start && offset < reference.end)
  if (!reference || !info) {
    return null
  }
  const entry = reference.kind === 'event' ? info.events.find(event => event.name === reference.name) :
    info.props.find(prop => camel(prop.name) === camel(reference.name || ''))
  if (!entry) {
    return reference.kind === 'component' && info.documentation ? { text: info.documentation,
      span: { start: reference.start, length: reference.end - reference.start } } : null
  }
  return { text: reference.kind === 'event' ? entry.signature || entry.name : propDetail(entry),
    documentation: entry.documentation, span: { start: reference.start, length: reference.end - reference.start } }
}

module.exports = { templateContext, metadataCompletions, metadataHover }
