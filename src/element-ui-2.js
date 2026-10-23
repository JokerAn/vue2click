'use strict'

const strings = values => values.split(' ').filter(Boolean).map(value => ({ value, text: JSON.stringify(value), string: true }))
const prop = (name, type, options = {}) => ({ name, type, required: false, values: [], ...options })
const event = name => ({ name, signature: name, documentation: '' })

module.exports = [
  { name: 'el-button', documentation: 'Element UI button.', events: ['click'].map(event), props: [
    prop('type', 'string', { values: strings('primary success warning danger info text') }),
    prop('size', 'string', { values: strings('medium small mini') }),
    ...['plain', 'round', 'circle', 'loading', 'disabled', 'autofocus'].map(name => prop(name, 'boolean')),
    prop('icon', 'string'), prop('native-type', 'string', { values: strings('button submit reset') })
  ] },
  { name: 'el-input', documentation: 'Element UI input.', events: ['input', 'change', 'blur', 'focus', 'clear'].map(event), props: [
    prop('type', 'string', { values: strings('text textarea password') }), prop('value', 'string | number'),
    prop('maxlength', 'number'), prop('minlength', 'number'), prop('show-word-limit', 'boolean'),
    prop('placeholder', 'string'), prop('clearable', 'boolean'), prop('disabled', 'boolean'),
    prop('size', 'string', { values: strings('medium small mini') }), prop('prefix-icon', 'string'),
    prop('suffix-icon', 'string'), prop('rows', 'number'), prop('autosize', 'boolean | object'),
    prop('readonly', 'boolean'), prop('resize', 'string', { values: strings('none both horizontal vertical') }),
    prop('autofocus', 'boolean')
  ] },
  { name: 'el-select', documentation: 'Element UI select.', events: ['change', 'visible-change', 'remove-tag', 'clear', 'blur', 'focus'].map(event), props: [
    prop('value', 'string | number | array | object'), prop('multiple', 'boolean'), prop('disabled', 'boolean'),
    prop('value-key', 'string'), prop('size', 'string', { values: strings('medium small mini') }),
    prop('clearable', 'boolean'), prop('collapse-tags', 'boolean'), prop('multiple-limit', 'number'),
    prop('name', 'string'), prop('autocomplete', 'string'), prop('placeholder', 'string'),
    prop('filterable', 'boolean'), prop('allow-create', 'boolean'), prop('filter-method', 'function'),
    prop('remote', 'boolean'), prop('remote-method', 'function'), prop('loading', 'boolean'),
    prop('loading-text', 'string'), prop('no-match-text', 'string'), prop('no-data-text', 'string'),
    prop('popper-class', 'string'), prop('reserve-keyword', 'boolean'), prop('default-first-option', 'boolean'),
    prop('popper-append-to-body', 'boolean')
  ] },
  { name: 'el-option', documentation: 'Element UI select option.', events: [], props: [
    prop('value', 'string | number | boolean | object', { required: true }), prop('label', 'string | number'),
    prop('disabled', 'boolean')
  ] },
  { name: 'el-dialog', documentation: 'Element UI dialog.', events: ['open', 'opened', 'close', 'closed'].map(event), props: [
    prop('title', 'string'), prop('visible', 'boolean', { required: true }), prop('width', 'string'),
    prop('fullscreen', 'boolean'), prop('top', 'string'), prop('modal', 'boolean'), prop('modal-append-to-body', 'boolean'),
    prop('append-to-body', 'boolean'), prop('lock-scroll', 'boolean'), prop('custom-class', 'string'),
    prop('close-on-click-modal', 'boolean'), prop('close-on-press-escape', 'boolean'), prop('show-close', 'boolean'),
    prop('before-close', 'function'), prop('center', 'boolean'), prop('destroy-on-close', 'boolean')
  ] },
  { name: 'el-table', documentation: 'Element UI table.', events: ['select', 'select-all', 'selection-change', 'cell-mouse-enter',
    'cell-mouse-leave', 'cell-click', 'cell-dblclick', 'row-click', 'row-contextmenu', 'row-dblclick',
    'header-click', 'sort-change', 'filter-change', 'current-change', 'header-dragend'].map(event), props: [
    prop('data', 'array', { required: true }), prop('height', 'string | number'), prop('max-height', 'string | number'),
    prop('stripe', 'boolean'), prop('border', 'boolean'), prop('fit', 'boolean'), prop('show-header', 'boolean'),
    prop('highlight-current-row', 'boolean'), prop('current-row-key', 'string | number'), prop('row-key', 'string | function'),
    prop('empty-text', 'string'), prop('default-expand-all', 'boolean'), prop('expand-row-keys', 'array'),
    prop('default-sort', 'object'), prop('tooltip-effect', 'string', { values: strings('dark light') }),
    prop('show-summary', 'boolean'), prop('sum-text', 'string'), prop('summary-method', 'function'),
    prop('span-method', 'function'), prop('select-on-indeterminate', 'boolean'), prop('indent', 'number'),
    prop('lazy', 'boolean'), prop('load', 'function')
  ] },
  { name: 'el-form', documentation: 'Element UI form.', events: ['validate'].map(event), props: [
    prop('model', 'object', { required: true }), prop('rules', 'object'), prop('label-position', 'string', { values: strings('right left top') }),
    prop('label-width', 'string'), prop('label-suffix', 'string'), prop('inline', 'boolean'), prop('inline-message', 'boolean'),
    prop('status-icon', 'boolean'), prop('show-message', 'boolean'), prop('size', 'string', { values: strings('medium small mini') }),
    prop('disabled', 'boolean'), prop('validate-on-rule-change', 'boolean'), prop('hide-required-asterisk', 'boolean')
  ] },
  { name: 'el-pagination', documentation: 'Element UI pagination.', events: ['size-change', 'current-change', 'prev-click', 'next-click'].map(event), props: [
    prop('small', 'boolean'), prop('background', 'boolean'), prop('page-size', 'number'), prop('total', 'number'),
    prop('page-count', 'number'), prop('pager-count', 'number'), prop('current-page', 'number'),
    prop('layout', 'string'), prop('page-sizes', 'array'), prop('popper-class', 'string'), prop('prev-text', 'string'),
    prop('next-text', 'string'), prop('disabled', 'boolean'), prop('hide-on-single-page', 'boolean')
  ] }
]
