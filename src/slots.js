'use strict'

const { isHTMLTag, isSVGTag, isMathMLTag, isVoidTag } = require('@vue/shared')

const parsedTemplates = new WeakMap()
const staticName = /^[A-Za-z_$][\w$-]*$/
const staticSlotName = /^[\w$.-]+$/
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

function component(node) {
  return node && !['template', 'slot', 'component'].includes(node.tag) &&
    !isHTMLTag(node.tag) && !isSVGTag(node.tag) && !isMathMLTag(node.tag)
}

// This small scanner retains unfinished attributes and their exact replacement
// spans. It reads only the indexed HTML template, never scripts or project files.
function templateNodes(index) {
  if (parsedTemplates.has(index)) {
    return parsedTemplates.get(index)
  }
  const nodes = []
  const text = index.text
  for (const block of index.blocks || []) {
    if (block.tag !== 'template' || block.external || block.lang && block.lang !== 'html') {
      continue
    }
    const stack = []
    let at = block.start
    while (at < block.end) {
      if (text.startsWith('<!--', at)) {
        const end = text.indexOf('-->', at + 4)
        at = end < 0 ? block.end : end + 3
        continue
      }
      if (text.startsWith('{{', at)) {
        const end = text.indexOf('}}', at + 2)
        at = end < 0 ? block.end : end + 2
        continue
      }
      if (text[at] !== '<') {
        at++
        continue
      }
      const close = /^<\/([\w:.-]+)\s*>/.exec(text.slice(at, Math.min(at + 200, block.end)))
      if (close) {
        const parent = stack.findLastIndex(node => node.tag === close[1])
        if (parent >= 0) {
          stack.length = parent
        }
        at += close[0].length
        continue
      }
      const opening = /^<([\w:.-]+)/.exec(text.slice(at, Math.min(at + 200, block.end)))
      if (!opening) {
        at++
        continue
      }
      const node = { tag: opening[1], start: at, parent: stack.at(-1), attributes: [] }
      at += opening[0].length
      let closed = false
      let selfClosing = false
      while (at < block.end) {
        while (/\s/.test(text[at] || '') && at < block.end) {
          at++
        }
        if (text[at] === '>') {
          at++
          closed = true
          break
        }
        if (text.startsWith('/>', at)) {
          at += 2
          closed = true
          selfClosing = true
          break
        }
        if (text[at] === '<' || at >= block.end) {
          break
        }
        const start = at
        while (at < block.end && !/[\s=<>/]/.test(text[at])) {
          at++
        }
        if (start === at) {
          at++
          continue
        }
        const attribute = { name: text.slice(start, at), start, nameEnd: at }
        while (at < block.end && /\s/.test(text[at])) {
          at++
        }
        if (text[at] === '=') {
          at++
          while (at < block.end && /\s/.test(text[at])) {
            at++
          }
          const quote = text[at] === '"' || text[at] === "'" ? text[at++] : null
          const quoteEnd = quote ? text.indexOf(quote, at) : -1
          const closedQuote = quoteEnd >= 0 && quoteEnd < block.end
          attribute.valueStart = at
          while (at < block.end && (quote ? text[at] !== quote && (closedQuote || text[at] !== '<') :
            !/[\s<>]/.test(text[at]) && !text.startsWith('/>', at))) {
            at++
          }
          attribute.valueEnd = at
          attribute.value = text.slice(attribute.valueStart, at)
          if (quote && text[at] === quote) {
            at++
          }
        }
        attribute.end = at
        node.attributes.push(attribute)
      }
      node.end = at
      node.literal = Boolean(node.parent?.literal || node.attributes.some(attribute => attribute.name === 'v-pre'))
      node.dynamic = node.tag === 'component' || node.attributes.some(attribute =>
        attribute.name === 'is' || attribute.name === ':is' || attribute.name === 'v-bind:is' ||
        attribute.name === 'v-bind' || /^(?::|v-bind:)\[/.test(attribute.name))
      nodes.push(node)
      if (closed && !selfClosing && !isVoidTag(node.tag)) {
        if (['script', 'style', 'textarea', 'title'].includes(node.tag)) {
          const end = text.indexOf(`</${node.tag}`, at)
          at = end < 0 ? block.end : end
        } else {
          stack.push(node)
        }
      }
    }
  }
  parsedTemplates.set(index, nodes)
  return nodes
}

function describeSlots(index) {
  const slots = new Map()
  for (const node of templateNodes(index)) {
    if (node.tag !== 'slot' || node.literal || node.dynamic ||
      node.attributes.some(attribute => [':name', 'v-bind:name'].includes(attribute.name))) {
      continue
    }
    const nameAttribute = node.attributes.find(attribute => attribute.name === 'name')
    const name = nameAttribute ? nameAttribute.value : 'default'
    if (!name || !staticSlotName.test(name)) {
      continue
    }
    if (!slots.has(name)) {
      slots.set(name, { name, props: [] })
    }
    const slot = slots.get(name)
    for (const attribute of node.attributes) {
      const binding = /^(?::|v-bind:)([\w$-]+)$/.exec(attribute.name)
      const prop = camel(binding ? binding[1] : attribute.name)
      if (!staticName.test(prop) || ['name', 'key', 'ref', 'slot', 'slotScope'].includes(prop) ||
        !binding && /^(?:v-|@|#)/.test(attribute.name) || slot.props.some(value => value.name === prop)) {
        continue
      }
      slot.props.push({ name: prop, type: binding ? 'unknown' : 'string' })
    }
  }
  return [...slots.values()]
}

function owner(node) {
  if (node.tag !== 'template') {
    return component(node) && !node.dynamic ? node : null
  }
  let parent = node.parent
  while (parent && parent.tag === 'template') {
    parent = parent.parent
  }
  return component(parent) && !parent.dynamic && !parent.literal ? parent : null
}

// Only object-pattern keys are contracts. Alias identifiers, nested patterns,
// defaults, expressions and rest bindings are deliberately outside this scope.
function parameterContext(attribute, offset) {
  if (attribute.valueStart === undefined || offset < attribute.valueStart || offset > attribute.valueEnd) {
    return null
  }
  const raw = attribute.value
  const relative = offset - attribute.valueStart
  const opening = /^\s*\{/.exec(raw)
  if (!opening) {
    return null
  }
  const segments = []
  let depth = 1
  let quote = null
  let escaped = false
  let start = opening[0].length
  for (let at = start; at < raw.length; at++) {
    const char = raw[at]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (['"', "'", '`'].includes(char)) {
      quote = char
    } else if ('{[('.includes(char)) {
      depth++
    } else if ('}])'.includes(char)) {
      depth--
      if (depth === 0) {
        segments.push({ start, end: at })
        start = raw.length + 1
        break
      }
    } else if (char === ',' && depth === 1) {
      segments.push({ start, end: at })
      start = at + 1
    }
  }
  if (start <= raw.length) {
    segments.push({ start, end: raw.length })
  }
  const current = segments.find(segment => relative >= segment.start && relative <= segment.end)
  if (!current) {
    return null
  }
  const before = raw.slice(current.start, relative)
  if (!/^\s*[\w$]*$/.test(before)) {
    return null
  }
  const prefix = /[\w$]*$/.exec(before)[0]
  const suffix = /^[\w$]*/.exec(raw.slice(relative, current.end))[0]
  const used = segments.filter(segment => segment !== current).flatMap(segment => {
    const key = /^\s*([A-Za-z_$][\w$]*)\s*(?:[:=]|$)/.exec(raw.slice(segment.start, segment.end))
    return key ? [key[1]] : []
  })
  return { start: offset - prefix.length, end: offset + suffix.length, prefix, used }
}

function slotContext(index, offset) {
  const node = templateNodes(index).find(node => offset >= node.start && offset <= node.end)
  if (!node || node.literal || node.dynamic) {
    return null
  }
  for (const attribute of node.attributes) {
    const shorthand = attribute.name.startsWith('#')
    const directive = attribute.name === 'v-slot' || attribute.name.startsWith('v-slot:')
    if (shorthand || directive) {
      const target = owner(node)
      const nameStart = attribute.start + (shorthand ? 1 : 'v-slot:'.length)
      const name = shorthand ? attribute.name.slice(1) : attribute.name === 'v-slot' ? 'default' : attribute.name.slice(7)
      if (!target || name.startsWith('[')) {
        continue
      }
      if (attribute.name !== 'v-slot' && offset >= nameStart && offset <= attribute.nameEnd &&
        (!name || staticSlotName.test(name))) {
        return { kind: 'slot', tag: target.tag, slotName: name || 'default', start: nameStart,
          end: attribute.nameEnd, prefix: index.text.slice(nameStart, offset) }
      }
      const parameter = parameterContext(attribute, offset)
      if (parameter && staticSlotName.test(name)) {
        return { kind: 'slotProp', tag: target.tag, slotName: name, ...parameter }
      }
    }
    if (attribute.name === 'slot' && attribute.valueStart !== undefined &&
      offset >= attribute.valueStart && offset <= attribute.valueEnd) {
      const target = node.parent
      if (component(target) && !target.dynamic && !target.literal && (!attribute.value || staticSlotName.test(attribute.value))) {
        return { kind: 'slot', tag: target.tag, slotName: attribute.value || 'default',
          start: attribute.valueStart, end: attribute.valueEnd, prefix: index.text.slice(attribute.valueStart, offset) }
      }
    }
    if (attribute.name === 'slot-scope' || attribute.name === 'scope' && node.tag === 'template') {
      const target = node.parent
      const slot = node.attributes.find(value => value.name === 'slot')
      if (!component(target) || target.dynamic || target.literal ||
        node.attributes.some(value => [':slot', 'v-bind:slot'].includes(value.name))) {
        continue
      }
      const slotName = slot?.value || 'default'
      const parameter = parameterContext(attribute, offset)
      if (parameter && staticSlotName.test(slotName)) {
        return { kind: 'slotProp', tag: target.tag, slotName, ...parameter }
      }
    }
  }
  return null
}

module.exports = { describeSlots, slotContext }
