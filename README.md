# Vue2Click

一个用于“转到定义”的轻量 VS Code 扩展。主要解决 Vue 2 单文件组件中，`this.createdInit()` 等本文件方法无法通过语言服务跳转的问题；也支持模板表达式、子组件标签与 props，以及本文件内的普通函数和变量。

## 用法

在符号上按住 **Cmd 并点击**（macOS）或 **Ctrl 并点击**（Windows/Linux），也可以把光标放在符号上按 **F12**。支持 Vue、JavaScript、JSX、TypeScript、TSX 文件。

Vue 模板中的事件、绑定和插值也支持跳转。例如，点击 `@click="gotoPage(1)"` 中的 `gotoPage`，会跳到当前组件 `methods` 里的 `gotoPage(type)`；参数和事件修饰符不会影响定位。

```vue
<template>
  <img :src="advertisementPNG" @click="gotoPage(1)" />
</template>
<script>
export default {
  data() { return { advertisementPNG: '' } },
  methods: {
    gotoPage(type) { /* 点击模板里的 gotoPage 会定位到这里 */ }
  }
}
</script>
```

组件标签和传参名称支持跨文件跳转：

```vue
<template>
  <AddressTab :address-params="addressParams" @ok="saveDraftF" />
</template>
<script>
import AddressTab from './components/address-tab.vue'
export default {
  components: { AddressTab },
  data() { return { addressParams: {} } },
  methods: { saveDraftF() {} }
}
</script>
```

- 点击 `AddressTab`（包括闭合标签或 `<address-tab>` 写法），跳到注册的子组件文件中的定义。
- 点击左侧 `address-params`，跳到子组件的 `props` 中的 `addressParams`，支持对象形式和字符串数组形式；驼峰、短横线形式会匹配。
- 点击右侧 `addressParams` 或 `saveDraftF`，跳到父组件的属性或方法定义。
- 点击 `v-model` 指令，跳到子组件对应的 prop：Vue 2 默认 `value` 或自定义 `model.prop`；声明了 `modelValue` 的组件也支持。`v-model:foo` 的 `foo` 跳到该 prop。

组件解析支持 `components: { AddressTab }`、重命名注册、字符串键、本文件组件变量、`Vue.extend` / `defineComponent`、静态 `() => import(...)` / `defineAsyncComponent(...)` / `require(...)`，以及明确的默认、命名和 `export *` 转导出。普通 Options API 的导入需要在 `components` 中注册；`<script setup>` 的组件导入可直接用于标签。子组件的运行时 `defineProps`、直接类型声明和本文件接口/类型别名也支持定位。

导入路径支持相对路径、省略扩展名、目录 `index`，以及最近的 `jsconfig.json` / `tsconfig.json` 中的 `baseUrl`、`paths` 和 `extends`（允许注释）。没有显式别名配置时，`@/`、`~/` 可回退到最近项目的 `src`；明确的别名配置优先。组件包会查找静态运行时入口，不会跳到 `.d.ts`。扩展只读取配置数据，不执行项目配置或组件代码。

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
- Vue 模板的 `@click` / `v-on`、`:src` / `v-bind`、`v-if` 等指令和 `{{ ... }}` 插值；`v-for`、`slot-scope`、`v-slot` 中的局部变量不会误跳到同名组件成员。模板表达式内部的函数参数、局部变量按词法作用域查找。
- 注册组件标签和子组件 props 的跨文件定义；子组件使用编辑器中最新的文本，包括未保存的修改。
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

本文件定义解析限于 `<script>` 和 HTML `<template>` 表达式；跨文件解析限于可静态确定的组件及其直接声明的 props。外部 `<script src>` / `<template src>`、Pug 等模板预处理器、全局组件注册、mixin/extends 注入的 props、导入的 props 类型、`defineModel`、动态组件来源、动态属性名（如 `this[name]`）及 `this.$refs` 指向的成员暂不解析。Webpack/Vue 配置中的动态别名、带 loader 或 URL 查询参数的导入也不解析。

原生 HTML/SVG 标签、模板注释和 `v-pre` 内容不参与组件跳转。普通文本和属性值字符串不参与表达式跳转；注册组件上的静态属性名称可跳到对应 prop。存在 `is` 覆盖、动态参数或对象 `v-bind` 时，组件来源可能变化，暂不提供该标签和左侧参数的跨文件跳转，右侧本地表达式仍可定位。事件名称暂不跳到子组件的 emits。

`v-for`、插槽声明的局部变量暂不提供定义。`this` 别名只识别直接赋值（`const me = this`），二次别名（`const other = me`）不解析；别名赋值出的动态属性（`me.foo = 1`）暂不视为声明。文件缺失、读取失败、配置损坏、循环/过深的导出链、定义歧义或请求被取消时不返回定义，其他已安装的语言服务仍可提供跳转。本地变量和方法定位不依赖跨文件读取。此扩展不修改被编辑的项目文件。

## 性能

文件索引按文档版本复用，修改或关闭文档后失效。模板表达式只在查询时解析，同一版本内相同的表达式共享语法树，各自保留原文件偏移和模板作用域。索引缓存按最近使用顺序淘汰，最多保留 32 个文档及 400 万源码字符；这是缓存容量限制，并非实际堆内存上限。

跨文件查询在单次请求中共享配置读取、文件存在性检查及文档加载；同时进行的相同路径解析或文档打开会合并为一个操作。每个请求仍独立检查取消状态和文档版本。完成后的路径解析结果不永久缓存，新查询会重新检查文件和配置。

运行 `npm run benchmark` 查看索引构建、重复查询和跨文件读取次数；`npm run benchmark -- --json` 输出完整数据。没有原始业务项目时使用合成文件，也可通过 `BENCH_PROJECT_ROOT` 指定业务项目。该基准不包含 VS Code UI、其他语言插件和扩展启动时间；跨文件基准中的请求级缓存对照不包含扩展的并发请求合并。测试通过操作次数和作用域验证复用行为，不使用机器相关的耗时阈值。
