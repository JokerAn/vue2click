# Vue2Click

一个用于“转到定义”的轻量 VS Code 扩展。主要解决 Vue 2 单文件组件中，`this.createdInit()` 等本文件方法无法通过语言服务跳转的问题；也支持本文件内的普通函数和变量。

## 用法

在符号上按住 **Cmd 并点击**（macOS）或 **Ctrl 并点击**（Windows/Linux），也可以把光标放在符号上按 **F12**。支持 Vue、JavaScript、JSX、TypeScript、TSX 文件。

```js
const count = 1
function getCount() {
  return count // 点击 count → 跳到 const count
}

export default {
  data() {
    return { amount: 0 }
  },
  methods: {
    async createdInit() {
      this.tmp = 1
      return this.tmp // 点击 tmp → 跳到上面的赋值
    },
    start() {
      this.createdInit() // 点击 createdInit → 跳到方法声明
      return this.amount // 点击 amount → 跳到 data() 返回的属性
    }
  }
}
```

解析范围：

- 函数声明、函数参数、`var`、`let`、`const`、解构绑定；同名局部变量按词法作用域查找。
- Vue 组件中 `methods`、`computed`、对象形式的 `props` 以及 `data()`/`setup()` 返回对象的属性；`watch: { 字段: { handler: function () {} } }` 的回调中也能跳转到同一组件成员。
- 普通对象方法、类成员，以及同一实例内**先前**以 `this.foo = ...` 赋值的属性。
- `this` 的别名：`const me = this`、`let self = this`、`var _this = this` 之后，`me.createdInit()` 与 `this.createdInit()` 一样跳转。别名同样按词法作用域生效——别的函数里同名但未赋值 `this` 的变量不会误跳。

```js
methods: {
  goBackPop() {},
  mounted() {
    let me = this // me 就是 this
    const params = {
      onClickBtnBack: () => {
        me.goBackPop() // 点击 goBackPop → 跳到 methods 里的声明
      }
    }
  }
}
```

扩展会区分嵌套对象方法和外层 Vue 组件的 `this`，避免把 `nested.go()` 中的 `this.foo` 错误跳到组件方法。`watch` 中的监听项本身**不是** `this.foo` 的声明；若 `data()` 中有同名属性，则跳到该属性。

## 边界

只解析当前文件；Vue 单文件组件仅解析 `<script>` 内容，不解析 `<template>` 表达式、外部 `<script src>`、跨文件导入、mixin 注入、动态属性名（如 `this[name]`）或 `this.$refs` 指向的成员。`this` 别名只识别直接赋值（`const me = this`），二次别名（`const other = me`）不解析；别名赋值出的动态属性（`me.foo = 1`）暂不视为声明。无法确定目标时不返回定义，其他已安装的语言服务仍可提供跳转。此扩展不修改被编辑的项目文件。
