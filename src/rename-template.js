'use strict'

const ts = require('typescript')
const { componentOptions, property, initializer } = require('./components')

const toKebab = name => name.replace(/\B([A-Z])/g, '-$1').toLowerCase()
const toCamel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
const stem = value => String(value).replace(/\\/g, '/').split('/').pop().toLowerCase()
const withoutExtension = value => value.replace(/\.(?:vue|[cm]?[jt]sx?)$/i, '')

function contains(node, offset) {
  return Boolean(node) && offset >= node.getStart() && offset <= node.end
}

// True when the cursor sits inside the `props` declaration, the only member a
// parent template can bind to by name.
function isPropOffset(index, offset) {
  const component = componentOptions(index)
  const props = component && property(component, 'props')
  return contains(props && initializer(props), offset)
}

// Declared prop names, from both the array and the object form.
function propNames(index) {
  const component = componentOptions(index)
  const value = component && initializer(property(component, 'props'))
  const names = new Set()
  if (!value) return names
  if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      if (ts.isStringLiteral(element)) names.add(element.text)
    }
  } else if (ts.isObjectLiteralExpression(value)) {
    for (const entry of value.properties) {
      if (entry.name && ts.isIdentifier(entry.name)) names.add(entry.name.text)
      else if (entry.name && ts.isStringLiteral(entry.name)) names.add(entry.name.text)
    }
  }
  return names
}

// True for declarations of any template-visible member. Renaming an ordinary
// local variable must never touch the template, even when the names collide.
function isMemberOffset(index, offset) {
  const component = componentOptions(index)
  if (!component) return false
  if (isPropOffset(index, offset)) return true
  for (const key of ['computed', 'methods']) {
    const entry = property(component, key)
    if (contains(entry && initializer(entry), offset)) return true
  }
  const data = property(component, 'data')
  const body = data && (data.body || data.initializer?.body)
  if (!body) return false
  if (ts.isBlock(body)) {
    return body.statements.some(statement => ts.isReturnStatement(statement) && contains(statement.expression, offset))
  }
  return contains(body, offset)
}

// Local names that a parent document binds to this component file.
function componentBindings(index, fileName) {
  const target = stem(fileName)
  const names = new Set()
  for (const binding of index.imports || []) {
    const specifier = stem(binding.specifier || '')
    if (!specifier || !binding.local?.text) continue
    if (specifier === target || withoutExtension(specifier) === withoutExtension(target)) {
      names.add(binding.local.text)
    }
  }
  return names
}

// Name spans of the given attributes on tags that resolve to this component.
// Both `user-name="x"` and `:user-name="x"` are covered, including `.sync`.
function attributeReferences(index, tagNames, names) {
  const tags = new Set([...tagNames].map(value => toCamel(value).toLowerCase()))
  const wanted = new Set(names)
  const result = []
  for (const tag of index.tags || []) {
    if (!tags.has(toCamel(tag.tag).toLowerCase())) continue
    for (const attribute of tag.attributes) {
      if (!attribute.name || !wanted.has(attribute.name)) continue
      const raw = index.text.slice(attribute.start, attribute.end)
      const at = raw.indexOf(attribute.name)
      if (at < 0) continue
      result.push({ start: attribute.start + at, end: attribute.start + at + attribute.name.length })
    }
  }
  return result
}

// Naming used for one occurrence keeps each site in its own convention.
function renamed(current, oldName, newName) {
  return current === toKebab(oldName) ? toKebab(newName) : newName
}

module.exports = { toKebab, toCamel, isPropOffset, isMemberOffset, propNames, componentBindings, attributeReferences, renamed }
