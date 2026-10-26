# Vue2Click 使用说明

[返回扩展介绍](../README.md)

一个面向 Vue 2 日常开发的独立 VS Code 扩展。提供单文件组件高亮、快速定义跳转、代码片段，以及 Vue/TypeScript 语义补全、自动导入、类型检查、悬停、参数提示、引用与重命名。支持成员大纲、常见静态 mixin/全局/Vuex/`$refs`/事件关系，以及 HTML/CSS 编辑辅助。不依赖 Vetur 或 Vue - Official。

## 日常使用场景

| 能力 | 常见操作 |
| --- | --- |
| Vue 成员大纲 | 通过文件大纲或 Cmd/Ctrl+Shift+O 在 data、computed、methods 与其成员间定位 |
| 悬停与 JSDoc | 鼠标停在方法、属性或导入函数上阅读类型、`/** ... */` 注释、`@param` 和返回说明 |
| 常量数组索引提示 | 悬停简单的公共 ESM 常量数组或 `arr[index]`，直接查看声明时的索引与值；固定数字索引只显示对应项 |
| 参数提示 | 输入函数括号、逗号时查看签名与当前参数 |
| 查找引用 | 修改方法前查看模板、脚本及同项目其他组件中的语义引用 |
| 语义重命名 | F2 同时修改声明及已确认的引用；同名局部变量按作用域区分 |
| 深层类型补全与自动导入 | 补全对象属性，选中导出函数建议后插入相应 import |
| 脚本与模板类型检查 | 提示不存在的成员、参数类型不匹配等错误；遵循 jsconfig/tsconfig |
| mixin / extends | 跳到静态继承的成员与 props，本组件声明优先；补全继承成员 |
| 全局组件与实例成员 | 追踪顶层静态 `Vue.component('Name', Component)`、`Vue.prototype.$name = ...` |
| Vuex 与组件 ref | 追踪静态 mapState/mapGetters/mapActions/mapMutations、store 路径与 `this.$refs.dialog.open()` |
| 组件事件 | 从父组件的 `@saved` 跳到子组件的 `$emit('saved')` 或 emits 声明 |
| 循环与插槽变量 | 从使用位置跳到 v-for、v-slot、slot-scope 中的声明，支持解构与嵌套遮蔽 |
| HTML / CSS / SCSS / Less | 补全、悬停、块内格式化、链接、折叠、关联标签编辑、CSS 诊断、颜色与变量跳转 |
| 组件契约提示 | 在模板里查看子组件 props 的类型、必填、默认值、JSDoc 和明确字面量选项；`@` 后提示静态 emits / `$emit` 事件 |
| 模板组件导入 | 输入本项目 Vue 文件名时可补全组件；选择后自动补 import 和 Options API `components` 注册，`script setup` 只补 import |
| 脚本阅读辅助 | Vue `<script>` 内的折叠、真实同符号高亮和逐级智能选区 |
| 模板到样式定位 | 从模板静态 class/id 及明确的 `:class` 字面量跳到 CSS/SCSS/Less 选择器，支持相对路径、静态配置别名及未保存样式内容 |
| 样式与资源路径 | 样式 import、`<style src>`、图片 src 和 CSS url 使用静态路径映射；独立 CSS/SCSS/Less 文件也支持静态 `@import`、`url()` 跳转与路径补全；别名链接点击时才解析 |
| 插槽提示 | 输入 `#` / `v-slot:` 提示子组件自身声明的插槽名；在对象解构中提示明确的 slot payload 名称，兼容静态 legacy slot/slot-scope |
| 生成事件方法 | 在直接事件处理函数名上主动运行快速修复，向当前 Options API 组件生成缺失的方法骨架 |
| 按需检查 | 命令面板运行 **VueClick: 检查当前文件**，需要时才分析；不会开启打开文件自动诊断 |
| 服务状态与恢复 | 命令查看当前项目、服务状态与排队数；补全异常时可重启语言服务，下次请求再启动 |
| 精选代码操作 | `Ctrl/Cmd + .` 自动导入缺失符号、整理 imports 或移除确认未使用的 imports |
| 标签与 Emmet | 输入模板开始标签后补闭合标签；原生 Emmet 未映射到 Vue 时，由 VueClick 提供 HTML/CSS/SCSS/Less 缩写 |
| 整文件格式化 | 一次格式化模板、JS/TS 脚本和 CSS/SCSS/Less；遵循编辑器格式选项，支持关闭并交给外部格式器 |

Vue/TypeScript 语义服务在独立工作线程内运行，使用仍支持 Vue 2 的语言核心。首次项目分析有冷启动成本，随后复用文档快照与类型程序。项目依赖中的 Vue 类型需要已安装；动态注入或未声明的第三方类型无法凭空获得准确类型。静态关系追踪补充定义与补全，不把运行时事件名、Vuex 字符串协议自动当作安全重命名范围。

JSDoc 有独立语法回退：即便关闭项目语言服务，明确可定位的本地和静态导入声明仍可显示注释；不依赖内置 JS/TS 悬停是否命中。

常量数组提示只读取字符串、数字、布尔值、`null`、`undefined` 和空槽组成的字面量数组，并跟随本地变量、简单 ESM 导入和 Vue `data` 别名。固定数字索引显示单项，动态索引显示声明时完整映射。数组发生明确的下标赋值、重赋值或 `push` 等修改时放弃提示；展开、嵌套、函数调用、计算表达式及无法唯一确定的函数传参也不猜测。函数传参只在同文件顶层函数、所有可解析直接调用都传入同一数组时生效。

组件契约优先读取组件源码，支持接口继承、类型别名与无冲突交叉类型、普通/type-only 导入、重命名与转导出，以及属性字面量别名。保留 `extends` / `mixins`、运行时 `validator: value => ['a', 'b'].includes(value)` 和 `@type` 字面量联合；不执行验证函数。解析有深度和工作量上限，冲突或无法确定的类型不生成候选值。复杂泛型、utility/mapped/conditional 类型和 `withDefaults` 不在这条静态契约路径中，项目语义服务仍可按自己的类型能力提供结果。

项目和组件库可在 `package.json` 的 `vetur.tags` / `vetur.attributes` 提供 JSON 元数据，支持属性、字面量选项及 `type: "event"` 事件。组件源码无法定位时使用这些数据；元数据内部按“项目声明 > 已安装包自带数据 > 内置兜底”的顺序选择。异常条目单独忽略，数字、布尔和字符串选项保留区别。Element UI 2 的常见组件及 Vue Router 3 只有有限基础兜底；没有新增 NutUI/Vant 专用清单。组件库信息优先来自其实际安装版本自带的数据。示例与边界见 [组件契约与元数据](component-contracts.md)。

## 高亮与基础编辑

独立安装即可识别 `.vue` 文件。支持 HTML 模板、Vue 指令与插值，以及 `<script>` 中的 JavaScript / TypeScript / JSX / TSX 和 `<style>` 中的 CSS / SCSS / Less 高亮；脚本和样式复用 VS Code 内置语法。支持单行、分行的块标签及嵌套 `<template>`。Pug、Sass、Stylus 的高亮依赖相应语法扩展，跳转和补全仍以本文列出的范围为准。

模板、脚本和样式的注释、括号规则随嵌入语言切换；模板使用 `<!-- -->`。不改变用户主题、保存行为和格式化设置。

## 片段与快速补全

输入前缀后从建议列表选择片段，再按 Tab 在占位符之间移动；未自动弹出时可用 **Ctrl+Space** 手动触发。

| 位置 | 前缀 | 内容 |
| --- | --- | --- |
| 空 Vue 文件 | `vbase`、`vue2` | Vue 2 Options API 单文件组件 |
| 脚本代码 | `vdata`、`vmethods`、`vcomputed`、`vwatch`、`vprops` | 常用选项 |
| 脚本代码 | `vcreated`、`vmounted` | 生命周期 |
| 模板标签属性 | `vif`、`velse`、`vfor`、`vmodel` | 条件、循环及双向绑定 |
| 模板标签属性 | `vbind`、`von`、`vslot` | 属性、事件及插槽（`vslot` 需要 Vue 2.6+） |

片段按所在区域提供，不会把 `vdata` 放进样式、注释和字符串。

- `this.` 和直接的 `this` 别名后，提示当前组件明确声明的 `data`、`props`、`computed`、`methods` 及 `setup()` 返回成员；嵌套普通函数或对象中的 `this` 不借用外层组件成员。
- 模板插值和指令表达式中提示组件成员及 `v-for` / 插槽局部变量；局部变量优先。`user.` 等深层对象属性不做类型推断。
- 输入组件标签时，提示 `components` 中直接注册的组件；`<script setup>` 中直接导入的 `.vue` 组件也支持。
- 已注册组件的属性位置提示子组件 props，使用短横线名称，保留已有的 `:`，过滤已经填写的属性。可读取运行时对象/字符串数组、同文件或直接导入的 `defineProps` 类型声明，使用未保存的编辑器内容。
- 快速补全与本地跳转复用文档版本缓存；项目类型能力由工作线程补充，可独立关闭。

快速补全支持 Vue 文件及设为 Vue 的未命名文件；未命名文件不解析跨文件 props，也不建立项目类型服务。前述 `user.` 深层对象属性等能力由开启的项目语言服务补充。

## 独立安装与设置

通过 VS Code 扩展面板的「从 VSIX 安装」选择 `vueClick-0.21.3.vsix`，重新加载窗口后即可使用。仅依赖 VS Code 自带的基础语法，不需要安装 Vetur 或 Vue - Official。若原来安装过其他 Vue 语言扩展，在当前工作区禁用后重新加载窗口，即可独立使用本扩展。

定义跳转、补全、片段和交互式语言服务默认开启。项目诊断默认关闭，避免打开 Vue 文件时自动冷启动整项目分析；需要自动诊断时可按工作区开启：

```json
{
  "vueClick.definition.enabled": true,
  "vueClick.completion.enabled": true,
  "vueClick.snippets.enabled": true,
  "vueClick.languageService.enabled": true,
  "vueClick.diagnostics.enabled": false,
  "vueClick.formatting.enabled": true,
  "vueClick.autoClosingTags.enabled": true
}
```

设置即时生效。`diagnostics.enabled` 默认关闭；只有显式开启时，活动 Vue 文档才会在打开或编辑后防抖执行项目诊断。**VueClick: 检查当前文件**始终可单次执行检查，检查后不会改变自动诊断开关。悬停、补全等交互能力仍在实际请求时启动语言服务。关闭 `languageService.enabled` 可停用项目语义能力，保留快速跳转、片段、静态注释回退和 HTML/CSS 服务。`formatting.enabled` 关闭时不提供整文件格式化，以便由 Prettier 等外部工具接管。标签闭合遵循 `html.autoClosingTags`；开启原生 `emmet.includeLanguages.vue` → `html` 时 VueClick 不再重复提供 Emmet。保留标准 `vue` 语言 ID，不修改其他扩展或用户编辑器的设置。

命令面板的 **VueClick: 查看项目与服务状态** 将当前文件、项目目录、诊断开关、线程状态和排队数显示在 VueClick 输出中，不启动语义线程。**VueClick: 重启语言服务** 释放线程与当前诊断，下次交互再建立服务，不修改文件或配置。线程在队列处理完后空闲五分钟，或所属项目的源码文档全部关闭时释放；重新使用时会有冷启动成本。安装/升级依赖或修改工作区外的元数据后，可用重启命令刷新数据。

扩展入口与语言工作线程均以 CommonJS 打包，TypeScript 编译器作为随包共享文件提供，标准类型声明逐文件压缩并在语言工作线程中按需解压缓存。扩展使用宿主提供的 `require('vscode')`，没有声明 `"type": "module"`。构建检查会实际加载入口、检查提供者注册，并启动打包后的工作线程验证 Vue 2、DOM、数组及 Promise 类型。体积与产物检查见 [0.21.3 打包验证](0.21.3-validation.md)，历史宿主验证见 [验证记录](lightweight-validation.md)。

模板语法适配自 Vetur v0.37.3，来源与许可见 [ThirdPartyNotices.txt](../ThirdPartyNotices.txt)。语义能力复用 Vue language-core / Volar / TypeScript；HTML/CSS 使用对应语言服务，没有移植 Vetur 的整套服务器。打包依赖的许可证通知随构建生成于 `dist/ThirdPartyNotices.txt`。

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

导入路径支持相对路径、省略扩展名、目录 `index`，以及最近的 `jsconfig.json` / `tsconfig.json` 中的 `baseUrl`、`paths` 和 `extends`（允许注释）。配置逐层查找，同目录优先 `tsconfig.json`，不越过工作区边界；静态解析与语义服务遵守同一选择规则。直接及继承配置中的 `${configDir}` 指向使用该配置的项目目录。没有显式别名配置时，`@/`、`~/` 可回退到最近项目的 `src`；明确的别名配置优先。组件包会查找静态运行时入口，不会跳到 `.d.ts`。扩展只读取已保存的配置数据，不执行项目配置或组件代码。

静态样式与资源路径沿用这些映射规则，包括自定义 `@src/*`。覆盖 Vue 模板及样式块中的资源引用，以及 JS/TS 文件的静态资源导入。图片、CSS/SCSS/Less 文件按资源处理，不建立 JS 定义索引；普通资源路径也可相对当前文件，不必添加 `./`。别名链接在点击时才读取相关配置与检查目标；补全只枚举用户请求的目录，最多返回 500 项，不递归列举项目。目录输入用于逐级补全，不当作源码定义或文件链接。尚未闭合的导入和样式路径字符串可继续补全，不生成完整文件链接；补全不会替换后面的 SFC 标签。普通 JS/TS 的源码文件补全仍由内置语言支持负责。

独立 `.css`、`.scss`、`.less` 文件中的静态 `@import` 和 `url()` 也支持相对路径、静态配置别名及路径补全，尊重定义与补全开关。独立样式的 `@import` 省略扩展名时，CSS 查找 `.css`，SCSS 查找 `.scss` / `.css`，Less 查找 `.less` / `.css`；仅在候选唯一时跳转。支持 Less 的 `@import (reference)` 语法。不会启动 Vue/TypeScript 项目线程或扫描整个项目；只在请求时解析当前文档，缓存最多保留 16 份文档及 200 万源码字符。未实现完整 Sass/Less 构建器的查找规则，包括 Sass partial / index、包解析、插值与变量计算；这些不确定路径不补造目标。

JS/TS 目录候选按路径来源与内置路径补全协作：相对路径和配置映射由启用的内置 JS/TS 服务提供目录，遵循其就绪时间与触发字符，也可手动请求补全；扩展独有的 `@/`、`~/` 或普通资源相对路径回退、关闭原生路径建议时继续提供静态目录候选。资源文件继续由扩展补充，不在补全提供者内部递归请求其他提供者。已使用的继承配置保存、删除或重新创建后，会释放受影响的语义服务；资源路径按新配置解析，语义服务在下次请求时才重建。未保存的配置修改不改变路径规则。

脚本中的普通 ES module 导入也支持跨文件定义跳转。例如：

```js
import { sgmCodeF as report } from '@/config/mUtils.js'

report({ code: 'example' }) // 点击 report → mUtils.js 中导出的 sgmCodeF 声明
```

支持命名导入、重命名、默认导入、直接的命名空间成员（`utils.report`），以及命名/默认/`export *` 转导出。定位导出的函数、类或变量声明；同名局部变量优先。读取目标文件当前的编辑器内容，未保存修改也会更新位置。不执行模块；类型专用导入、CommonJS 导出和动态对象成员暂不解析，导出链有循环、深度/工作量超限或歧义时不返回定义。

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

模板样式定位只跟随当前 SFC、静态样式 import、`<style src>` 和 `@import` 的相对路径或明确配置映射，不做全项目样式扫描。忽略动态类名、插值选择器、SCSS `&-suffix` 拼接及未配置的包路径；保留原文件位置与未保存内容。单次查询限制为 32 个样式源、64 次读取、单源 256 KiB、总计 2 MiB、递归深度 8，超限不继续读取。资源别名解析不处理 loader 前缀、查询后缀、动态表达式或可执行配置；普通远程 URL 链接继续交给编辑器与嵌入式语言服务。

插槽名和参数提示来自子组件自身的静态 `<slot>`，绑定 payload 的类型标为 `unknown`，不猜表达式类型；外部模板、动态插槽名、动态组件和对象展开不补造契约。已有插槽局部变量的跳转继续保留。

**生成方法**通过光标所在事件函数名上的 `Ctrl/Cmd + .` 主动触发，不要求开启自动诊断，也不由打开文件或自动灯泡查询启动项目分析。支持直接 `@click="submit(row)"` / `@click="submit"`，生成 JS 参数名或 TS `unknown` 参数。仅修改直接 `export default { ... }` 的当前 Options API 组件；已有成员、模板局部变量、mixin/extends、动态成员来源、包装构造器和 script setup 均保守跳过。生成的是空方法骨架，不实现业务行为，应用后可在编辑器撤销。

快速解析限于 `<script>` 和 HTML `<template>` 表达式；跨文件覆盖静态 ES module 导入、组件和直接声明 props。项目语言服务进一步处理类型、引用与重命名，静态追踪进一步处理 mixin、全局注册、Vuex、ref 和事件。类型完整性受项目声明与配置限制。

模板成员诊断只在选项对象完全静态时启用：存在 `mixins`、`extends`、`setup`、展开运算符、计算属性名、非内联的共享选项对象或脚本语法错误时整篇跳过；`$`/`_` 开头的实例成员、指令参数、`v-for`/插槽作用域、内联箭头函数参数、过滤器名称和浏览器全局都不参与判断。资源缺失诊断只检查相对路径且必须带扩展名，项目别名与远程 URL 不报，因此不会把 Webpack 别名或 loader 的扩展名规则误判为错误；这两类静态检查可用 `vueClick.diagnostics.staticChecks` 单独关闭。重命名组件成员会同步当前 SFC 模板中的引用；重命名 props 时还会更新已打开文档及项目内父模板的同名属性（最多 200 个 `.vue`、单文件 512 KiB），保留 kebab-case 写法，其他成员不扫描项目。

仍有明确边界：外部 `<template src>`、Pug 等模板预处理器的源位置映射、运行时计算的组件/事件名、插件安装时动态注册的成员、动态 Vuex 模块及复杂 store 工厂、无法唯一确定的 ref、动态属性名（如 `this[name]`），以及 Webpack/Vue 配置中的可执行别名。不会运行项目配置或组件代码。静态全局注册支持导入 Vue 的顶层注册，以及明确默认导出的插件对象中的 `install(Vue)`、`Plugin.install = function(Vue) {}` 等直接声明；仅使用第一个参数，排除变量遮蔽。不会执行 `Vue.use`，因此这些结果表示源码中明确声明的注册，不证明安装钩子实际执行。TypeScript 声明过的全局类型由类型服务处理。

原生 HTML/SVG 标签、模板注释和 `v-pre` 内容不参与静态组件跳转。普通文本和属性值字符串不参与表达式跳转；注册组件上的静态属性名称可跳到对应 prop。存在 `is` 覆盖、动态参数或对象 `v-bind` 时，快速路径不猜测组件来源；项目语言服务只在能够推断时补充。

快速路径中，`this` 别名只识别直接赋值（`const me = this`）；更深的关系由项目类型服务尝试推断。文件缺失、读取失败、循环/过深的导出链、定义歧义或取消时不强行生成静态结果。定义跳转、查询与诊断不写项目文件；自动导入、格式化和重命名通过标准编辑器编辑接口，在用户主动操作后产生编辑。

## 性能

文件索引按文档版本复用，修改或关闭文档后失效。模板表达式只在查询时解析，同一版本内相同的表达式共享语法树，各自保留原文件偏移和模板作用域。索引缓存按最近使用顺序淘汰，最多保留 32 个文档及 400 万源码字符；这是缓存容量限制，并非实际堆内存上限。

快速跨文件查询在单次请求中共享配置读取、文件存在性检查及文档加载；并发请求合并相同文件的在途读取。项目语言服务保留一个活跃项目工作线程，切换项目时释放旧线程，只同步当前项目的打开源码文档并按版本增量发送；未保存内容优先，文件与配置变更通知会使相关状态失效。组件契约查询最多复用 64 个结果，项目版本变化后失效；源码事件遍历不再为每个语法节点创建异步任务。线程支持空闲释放与手动恢复，不承诺峰值内存固定上限。诊断默认关闭；开启后只在活动 Vue 文档中防抖刷新，后台文件不抢占交互请求所在的项目。脚本折叠/高亮/选区与模板编辑增强按编辑器功能请求当前文档，不建立开页全项目扫描。工作线程一次处理一个请求，已取消且尚未开始的请求会从队列移除。项目分析需要额外内存，原有轻量路径的缓存上限不代表新类型服务的内存上限。

语义服务记录实际配置依赖，包括外部和缺失的继承配置（最多 512 个依赖路径）。相关配置保存、创建或删除后，只释放受影响的活跃服务，下一次请求时重建；不会由通知主动启动项目分析。请求前检查已记录配置的变化，避免漏掉文件系统通知。静态模块缓存随项目版本更新，无关子目录配置不释放当前服务。

扩展激活时只注册编辑能力，不建立全工作区文件监听；监听在项目语言服务首次真正启动时才创建，因此只打开样式或普通脚本文件的工作区不会承担额外的递归监听开销。语言工作线程异常退出时提示一次并可一键重启，同一项目不会重复弹出。

运行 `npm run benchmark` 查看索引构建、重复查询和跨文件读取次数；`npm run benchmark -- --json` 输出完整数据。没有原始业务项目时使用合成文件，也可通过 `BENCH_PROJECT_ROOT` 指定业务项目。该基准不包含 VS Code UI、其他语言插件和扩展启动时间；跨文件基准中的请求级缓存对照不包含扩展的并发请求合并。测试通过操作次数和作用域验证复用行为，不使用机器相关的耗时阈值。

`npm run benchmark:file -- /绝对路径/Component.vue` 对指定真实文件运行只读基准，包含索引、分散位置的重复跳转/补全、真实组件与 props 跨文件解析，并用 SHA-256 核对读取的源码和配置保持不变。该命令输出 JSON，不写入业务项目。

## 开发与验证

`npm test` 运行解析、作用域、补全、取消/版本失效和真实 TextMate 引擎测试；`npm run package` 测试、构建并生成可通过 VS Code「从 VSIX 安装」使用的安装包。

`npm run test:vscode` 在独立临时配置中运行真实 VS Code 扩展宿主测试，不修改日常编辑器配置。默认下载稳定版，可通过 `VSCODE_TEST_VERSION=1.90.0` 检查声明的最低支持版本，或通过 `VSCODE_EXECUTABLE_PATH` 指向本机 VS Code 可执行文件。测试验证文件识别、编辑器补全、跳转、未保存 props、配置开关及内置 JS/TS/CSS 语法的实际分词。

0.21.1 的 JoyCode 实测及修复回归见 [验证记录](0.21.1-validation.md)。隔离测试工作区关闭自动保存；原生路径检查会确认内置 JS/TS 服务和项目配置就绪。

`VUECLICK_READ_TEST_ONLY=1` 选择不依赖窗口焦点的只读 API 专项，检查跨文件 JSDoc 范围、参数说明，以及独立 CSS/SCSS/Less 的定义、链接和未闭合别名路径补全，并确认不启动项目线程；它不替代物理按键、建议列表或撤销等操作验收。使用本机可执行文件时无需下载编辑器。0.21 收尾版的范围与验收结果见 [最终验证记录](final-validation.md)。

`npm run benchmark:registry` 使用 2,000、5,000、10,000 个内存候选源码验证全局索引加载次数。修改一个文件后只重新加载该文件，但仍枚举文件名、合并贡献；这个基准不包含磁盘、编辑器通信或项目语义程序。

全局注册表在第一次相关查询时构建，后续按文件失效；未保存源码优先，关闭后恢复磁盘内容。嵌入语言缓存按当前代码块延迟创建，但文档版本变化仍会使对应文档缓存失效，不声称复用未改变块的解析树。

设置 `VUECLICK_PATH_TEST_ONLY=1` 可仅运行路径一致性宿主验收；设置 `VUECLICK_OPERATION_TEST_ONLY=1` 可仅运行建议接受与撤销验收。这些测试与真实物理按键、建议自动弹出及用户快捷键冲突的验收分开，详见 `docs/daily-operation-acceptance.md`。测试报告分别列出通过、失败和因业务样例不存在而跳过的项目。

扩展宿主测试在禁用其他用户扩展的条件下运行，并确认 Vetur 与 Vue - Official 没有加载，验证独立使用。

设置 `VUECLICK_TEST_FILE=/绝对路径/Component.vue` 可增加真实大文件实测，在编辑器中检查分散位置的跳转、成员补全、跨文件 props、高亮分词并输出延迟分布。业务源文件只读，修改行为仅在临时样例和未命名文档中验证。
