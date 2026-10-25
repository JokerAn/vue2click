'use strict'

const ts = require('typescript')
const path = require('node:path')
const { nodeAt } = require('./insight')
const { vueMember, componentMembers, thisOwner, isInstanceReceiver } = require('./resolver')
const { componentOptions, componentRegistration, resolveComponent, property, initializer, localObject, propDeclaration, key } = require('./components')
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
const same = (left, right) => camel(left).toLowerCase() === camel(right).toLowerCase()
const hit = (index, node) => node ? { fileName: index.fileName, textSpan: { start: node.getStart(index.root), length: node.end - node.getStart(index.root) } } : null

function refAccessName(expression) {
  if (ts.isPropertyAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    expression.expression.name.text === '$refs') {
    return expression.name.text
  }
  if (ts.isElementAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    expression.expression.name.text === '$refs' &&
    expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text
  }
  return null
}

function refTags(index, name) {
  return index.tags.filter(tag => !tag.dynamic &&
    tag.attributes.some(attribute => attribute.name === 'ref' && attribute.value === name))
}

function createIndirectService(files, load, resolveModule) {
  const globals = require('./global-registry').createGlobalRegistry(files, load)
  const registry = () => globals.get()
  const context = () => ({ loadIndex: load, resolveModule, remaining: 2048 })
  async function component(index, tag, globals) {
    let expression = componentRegistration(index, tag)
    if (!expression) {
      const registrations = globals.components.filter(value => same(value.name, tag))
      if (registrations.length !== 1) {
        return null
      }
      index = registrations[0].index
      expression = registrations[0].expression
    }
    return resolveComponent(index, expression, context(), new Set(), 0)
  }
  async function inherited(index, options, name, seen = new Set()) {
    if (!options || seen.has(options)) {
      return null
    }
    seen.add(options)
    const own = vueMember(options, name) || propDeclaration(index, options, name)
    if (own) {
      return hit(index, own)
    }
    let list = initializer(property(options, 'mixins'))
    if (list && ts.isIdentifier(list)) {
      list = index.root.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
        .find(declaration => declaration.name.text === list.text)?.initializer
    }
    const entries = list && ts.isArrayLiteralExpression(list) ? [...list.elements].reverse() : []
    const base = initializer(property(options, 'extends'))
    if (base) {
      entries.push(base)
    }
    for (const expression of entries) {
      const resolved = await resolveComponent(index, expression, context(), new Set(), 0)
      const result = resolved && await inherited(resolved.index, resolved.options, name, seen)
      if (result) {
        return result
      }
    }
    return null
  }
  async function storeMember(store, group, segments, namespace, seen = new Set()) {
    const resolved = await resolveComponent(store.index, store.expression, context(), new Set(), 0)
    if (!resolved?.options || seen.has(resolved.options)) {
      return []
    }
    seen.add(resolved.options)
    const { index, options } = resolved
    if (namespace.length) {
      const modules = localObject(index, initializer(property(options, 'modules')))
      const module = property(modules, namespace[0])
      return module ? storeMember({ index, expression: initializer(module) }, group, segments, namespace.slice(1), seen) : []
    }
    let declaration = property(options, group)
    let object = localObject(index, initializer(declaration))
    if (!object && group === 'state' && declaration) {
      const body = declaration.body || declaration.initializer?.body
      const value = body && ts.isBlock(body) ? body.statements.find(ts.isReturnStatement)?.expression : body
      object = value && localObject(index, value)
    }
    for (const segment of segments) {
      declaration = property(object, segment)
      object = localObject(index, initializer(declaration))
    }
    return declaration?.name ? [hit(index, declaration.name)] : []
  }
  function memberQuery(index, offset) {
    const expression = index.templates.find(value => offset >= value.start && offset < value.end)
    if (expression) {
      const node = nodeAt(expression.index, expression.source.fromSource[offset - expression.start] + expression.prefix)
      if (node && ts.isIdentifier(node) && !expression.locals.has(node.text) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        return node.text
      }
      return null
    }
    const node = nodeAt(index, offset)
    if (node && ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name === node && isInstanceReceiver(index, node.parent.expression, offset) &&
      index.options.includes(thisOwner(index, node))) {
      return node.text
    }
    return null
  }
  return {
    invalidate: file => globals.invalidate(file),
    dispose: () => globals.dispose(),
    async componentInfo(index, tag) {
      const globals = await registry()
      const child = await component(index, tag, globals)
      return child ? require('./component-info').describeComponent(child.index, child.options, context()) : null
    },
    async definitions(index, offset) {
      const globals = await registry()
      const reference = index.templateReferences.find(value => offset >= value.start && offset < value.end)
      if (reference) {
        const child = await component(index, reference.tag, globals)
        if (!child) {
          return []
        }
        if (reference.kind === 'component') {
          return [hit(child.index, child.node)].filter(Boolean)
        }
        if (reference.kind === 'prop') {
          const value = await inherited(child.index, child.options, camel(reference.name))
          return value ? [value] : []
        }
        if (reference.kind === 'event') {
          const result = []
          const declared = property(child.options, 'emits')?.initializer
          if (declared && ts.isArrayLiteralExpression(declared)) {
            const event = declared.elements.find(value => ts.isStringLiteral(value) && value.text === reference.name)
            if (event) {
              result.push(hit(child.index, event))
            }
          } else if (declared && ts.isObjectLiteralExpression(declared)) {
            const event = property(declared, reference.name)
            if (event?.name) {
              result.push(hit(child.index, event.name))
            }
          }
          function visit(node) {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === '$emit' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
              node.arguments[0].text === reference.name &&
              isInstanceReceiver(child.index, node.expression.expression, node.getStart(child.index.root)) &&
              child.index.options.includes(thisOwner(child.index, node))) {
              result.push(hit(child.index, node.arguments[0]))
            }
            ts.forEachChild(node, visit)
          }
          visit(child.index.root)
          for (const expression of child.index.templates) {
            function visitExpression(node) {
              if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
                node.expression.text === '$emit' && !expression.locals.has('$emit') &&
                !expression.index.bindings.some(binding => binding.name === '$emit') &&
                node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
                node.arguments[0].text === reference.name) {
                const start = node.arguments[0].getStart(expression.index.root) - expression.prefix
                const end = node.arguments[0].end - expression.prefix
                result.push({ fileName: child.index.fileName, textSpan: {
                  start: expression.start + expression.source.toSource[start],
                  length: expression.source.toSource[end] - expression.source.toSource[start]
                } })
              }
              ts.forEachChild(node, visitExpression)
            }
            visitExpression(expression.index.root)
          }
          return result
        }
      }
      const node = nodeAt(index, offset)
      // A static component ref ties this.$refs.name.member to that component's declaration.
      if (node && ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)) {
        const access = node.parent
        const receiver = access.expression
        const name = refAccessName(receiver)
        if (name && index.options.includes(thisOwner(index, node))) {
          const tags = refTags(index, name)
          const tag = tags.length === 1 ? tags[0] : undefined
          const child = tag && !tag.inLoop && await component(index, tag.tag, globals)
          const value = child && await inherited(child.index, child.options, node.text)
          return value ? [value] : []
        }
        const directName = refAccessName(access)
        if (directName && node.parent.name === node && index.options.includes(thisOwner(index, node))) {
          const tags = refTags(index, directName)
          const tag = tags.length === 1 ? tags[0] : undefined
          const attribute = tag?.attributes.find(value => value.name === 'ref')
          return attribute ? [{ fileName: index.fileName, textSpan: { start: attribute.start, length: attribute.end - attribute.start } }] : []
        }
        const segments = []
        let storeAccess = node.parent
        if (storeAccess.name === node) {
          while (ts.isPropertyAccessExpression(storeAccess)) {
            segments.unshift(storeAccess.name.text)
            storeAccess = storeAccess.expression
          }
          if (storeAccess.kind === ts.SyntaxKind.ThisKeyword && segments[0] === '$store' &&
            ['state', 'getters'].includes(segments[1]) && segments.length > 2 &&
            index.options.includes(thisOwner(index, node))) {
            const group = segments[1]
            const names = group === 'getters' ? segments.slice(2).join('.').split('/') : segments.slice(2)
            const direct = (await Promise.all(globals.stores.map(store => storeMember(store, group, names, [])))).flat()
            if (direct.length) {
              return direct
            }
            const field = names.pop()
            return (await Promise.all(globals.stores.map(store => storeMember(store, group, [field], names)))).flat()
          }
        }
      }
      if (node && ts.isStringLiteral(node) && ts.isElementAccessExpression(node.parent)) {
        const name = refAccessName(node.parent)
        if (name && index.options.includes(thisOwner(index, node))) {
          const tags = refTags(index, name)
          const tag = tags.length === 1 ? tags[0] : undefined
          const attribute = tag?.attributes.find(value => value.name === 'ref')
          return attribute ? [{ fileName: index.fileName, textSpan: { start: attribute.start, length: attribute.end - attribute.start } }] : []
        }
        const segments = [node.text]
        let access = node.parent.expression
        while (ts.isPropertyAccessExpression(access) ||
          (ts.isElementAccessExpression(access) && access.argumentExpression && ts.isStringLiteral(access.argumentExpression))) {
          segments.unshift(ts.isPropertyAccessExpression(access) ? access.name.text : access.argumentExpression.text)
          access = access.expression
        }
        if (access.kind === ts.SyntaxKind.ThisKeyword && segments[0] === '$store' &&
          ['state', 'getters'].includes(segments[1]) && segments.length > 2 &&
          index.options.includes(thisOwner(index, node))) {
          const names = segments[1] === 'getters' ? segments.slice(2).join('/').split('/') : segments.slice(2)
          const field = names.pop()
          const result = (await Promise.all(globals.stores.map(store =>
            storeMember(store, segments[1], [field], names)))).flat()
          if (result.length) {
            return result
          }
        }
      }
      const name = memberQuery(index, offset)
      if (name) {
        const options = componentOptions(index)
        const value = await inherited(index, options, name)
        if (value) {
          return [value]
        }
        for (const group of ['computed', 'methods']) {
          const object = localObject(index, initializer(property(options, group)))
          for (const spread of object?.properties || []) {
            const call = ts.isSpreadAssignment(spread) && spread.expression
            if (!call || !ts.isCallExpression(call)) {
              continue
            }
            const helper = ts.isIdentifier(call.expression) ? call.expression.text : ''
            const binding = index.imports.find(binding => binding.specifier === 'vuex' && binding.local.text === helper)
            const kind = binding?.symbol
            const groups = { mapState: 'state', mapGetters: 'getters', mapActions: 'actions', mapMutations: 'mutations' }
            if (!groups[kind]) {
              continue
            }
            const args = [...call.arguments]
            const namespace = ts.isStringLiteral(args[0]) ? args.shift().text.split('/').filter(Boolean) : []
            const mappings = args[0]
            let original
            let statePath
            if (mappings && ts.isArrayLiteralExpression(mappings)) {
              original = mappings.elements.find(element => ts.isStringLiteral(element) && element.text === name)?.text
            } else if (mappings && ts.isObjectLiteralExpression(mappings)) {
              const value = initializer(property(mappings, name))
              original = value && ts.isStringLiteral(value) ? value.text : undefined
              if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && value.parameters.length &&
                ts.isIdentifier(value.parameters[0].name)) {
                let body = ts.isBlock(value.body) ? value.body.statements.find(ts.isReturnStatement)?.expression : value.body
                const path = []
                while (body && ts.isPropertyAccessExpression(body)) {
                  path.unshift(body.name.text)
                  body = body.expression
                }
                if (body && ts.isIdentifier(body) && body.text === value.parameters[0].name.text) {
                  statePath = path
                }
              }
            }
            if (original || statePath) {
              const results = await Promise.all(globals.stores.map(store => storeMember(store, groups[kind], statePath || [original], namespace)))
              return results.flat()
            }
          }
        }
        return globals.members.filter(value => value.name === name)
          .map(value => ({ ...hit(value.index, value.node), sourceKind: 'Vue.prototype' }))
      }
      // Vuex's runtime string protocol is kept separate from identifier renaming.
      if (node && ts.isStringLiteral(node) && ts.isCallExpression(node.parent)) {
        const call = node.parent
        if (call.arguments[0] === node && ts.isPropertyAccessExpression(call.expression) &&
          ['dispatch', 'commit'].includes(call.expression.name.text) && ts.isPropertyAccessExpression(call.expression.expression) &&
          call.expression.expression.name.text === '$store' &&
          call.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
          index.options.includes(thisOwner(index, node))) {
          const names = node.text.split('/')
          const name = names.pop()
          const group = call.expression.name.text === 'dispatch' ? 'actions' : 'mutations'
          return (await Promise.all(globals.stores.map(store => storeMember(store, group, [name], names)))).flat()
        }
      }
      return []
    },
    async completions(index, offset) {
      const globals = await registry()
      const result = globals.members.map(value => ({ name: value.name, kind: 'property',
        detail: `Vue.prototype (${path.relative(path.dirname(index.fileName), value.index.fileName).replace(/\\/g, '/')})` }))
      const seen = new Set()
      async function collect(index, options) {
        if (!options || seen.has(options)) {
          return
        }
        seen.add(options)
        result.push(...componentMembers(index, options).map(value => ({ ...value, detail: 'Vue mixin / extends' })))
        for (const group of ['computed', 'methods']) {
          const object = localObject(index, initializer(property(options, group)))
          for (const spread of object?.properties || []) {
            const call = ts.isSpreadAssignment(spread) && spread.expression
            if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
              continue
            }
            const binding = index.imports.find(binding => binding.specifier === 'vuex' &&
              binding.local.text === call.expression.text && ['mapState', 'mapGetters', 'mapActions', 'mapMutations'].includes(binding.symbol))
            if (!binding) {
              continue
            }
            const mappings = call.arguments[ts.isStringLiteral(call.arguments[0]) ? 1 : 0]
            const names = mappings && ts.isArrayLiteralExpression(mappings)
              ? mappings.elements.filter(ts.isStringLiteral).map(value => value.text)
              : mappings && ts.isObjectLiteralExpression(mappings) ? mappings.properties.map(key).filter(Boolean) : []
            result.push(...names.map(name => ({ name, kind: group === 'methods' ? 'method' : 'property', detail: `Vuex ${binding.symbol}` })))
          }
        }
        const list = initializer(property(options, 'mixins'))
        const expressions = list && ts.isArrayLiteralExpression(list) ? [...list.elements] : []
        const base = initializer(property(options, 'extends'))
        if (base) {
          expressions.push(base)
        }
        for (const expression of expressions) {
          const resolved = await resolveComponent(index, expression, context(), new Set(), 0)
          if (resolved) {
            await collect(resolved.index, resolved.options)
          }
        }
      }
      await collect(index, componentOptions(index))
      const before = index.text.slice(0, offset)
      const ref = /this\.\$refs\.([\w$]+)\.[$\w]*$/.exec(before)
      if (ref) {
        const matches = index.tags.filter(tag => !tag.dynamic &&
          tag.attributes.some(attribute => attribute.name === 'ref' && attribute.value === ref[1]))
        const child = matches.length === 1 && !matches[0].inLoop && await component(index, matches[0].tag, globals)
        if (!child) {
          return []
        }
        result.length = 0
        seen.clear()
        await collect(child.index, child.options)
        return result
      }
      if (/this\.\$refs\.[$\w]*$/.test(before)) {
        return index.tags.flatMap(tag => tag.attributes.filter(attribute => attribute.name === 'ref' && attribute.value)
          .map(attribute => ({ name: attribute.value, kind: 'property', detail: `Vue ref (${tag.tag})` })))
      }
      if (/<[\w-]*$/.test(before)) {
        return globals.components.map(value => ({ name: value.name, kind: 'class', detail: 'Vue global component' }))
      }
      const tag = index.tags.find(value => offset >= value.start && offset <= value.end)
      const attribute = /(?:\s|:)([\w-]*)$/.exec(before)
      if (tag && attribute && !tag.dynamic) {
        const child = await component(index, tag.tag, globals)
        const props = []
        const visited = new Set()
        async function collectProps(index, options) {
          if (!options || visited.has(options)) {
            return
          }
          visited.add(options)
          let declaration = initializer(property(options, 'props'))
          declaration = localObject(index, declaration) || declaration
          if (declaration && ts.isObjectLiteralExpression(declaration)) {
            props.push(...declaration.properties.map(value => key(value)).filter(Boolean))
          } else if (declaration && ts.isArrayLiteralExpression(declaration)) {
            props.push(...declaration.elements.filter(ts.isStringLiteral).map(value => value.text))
          }
          const list = initializer(property(options, 'mixins'))
          const expressions = list && ts.isArrayLiteralExpression(list) ? [...list.elements] : []
          const base = initializer(property(options, 'extends'))
          if (base) {
            expressions.push(base)
          }
          for (const expression of expressions) {
            const resolved = await resolveComponent(index, expression, context(), new Set(), 0)
            if (resolved) {
              await collectProps(resolved.index, resolved.options)
            }
          }
        }
        if (child) {
          await collectProps(child.index, child.options)
        }
        const used = new Set(tag.attributes.map(value => value.name))
        return [...new Set(props)].map(name => ({ original: name, name: name.replace(/\B([A-Z])/g, '-$1').toLowerCase() }))
          .filter(value => !used.has(value.original) && !used.has(value.name))
          .map(value => ({ name: value.name, kind: 'property', detail: 'Vue inherited / global prop',
            replacementSpan: { start: offset - attribute[1].length, length: attribute[1].length } }))
      }
      const expression = index.templates.find(expression => offset >= expression.start && offset <= expression.end)
      if (expression) {
        const local = expression.source.text.slice(0, expression.source.fromSource[offset - expression.start])
        return /(?:^|[^.\w$])(?:this\.)?[$\w]*$/.test(local) ? result : []
      }
      const node = nodeAt(index, Math.max(0, offset - 1))
      return /this\.[$\w]*$/.test(before) && node && index.options.includes(thisOwner(index, node)) ? result : []
    }
  }
}

module.exports = { createIndirectService }
