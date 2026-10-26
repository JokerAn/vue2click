# Vue2Click

Vue 2 项目的独立编辑支持。**不依赖 Vetur 或 Vue - Official**，装完直接可用，无运行时依赖。

`F12` 跳转 · `Ctrl+Space` 补全 · `Ctrl/Cmd + .` 代码操作 · 输入 `vbase` 生成组件骨架

## 三个差异点

- **数字索引直接翻译成业务文案**：`serviceOperateBtn[1]` 悬停显示 `1 → "我要催单"`，动态索引显示完整映射，不用再翻公共常量文件。
- **改名不会悄悄改坏**：重命名组件成员会同步当前 SFC 模板；改 props 会同步父组件的 `:user-name`，保留 kebab-case 写法。
- **轻量**：项目语义服务按需启动，普通 `.js` / `.css` 文件不会挂上全仓库监听。

## 功能

| 能力 | 说明 |
| --- | --- |
| 跳转与补全 | 模板、脚本、样式之间的定义跳转；成员、组件、props、自动导入补全；`props` / 事件 / 插槽契约提示 |
| 类型与语义 | 类型悬停、`/** */` 注释、参数提示、查找引用、语义重命名 |
| 检查 | 模板中未声明的成员、缺失的相对资源、脚本诊断、CSS/SCSS/Less 校验，支持单文件手动检查 |
| 样式 | 模板 `class` 定位到样式规则；`@import` / `url()` 跳转；HTML/CSS/SCSS/Less 路径补全与格式化 |
| 编辑 | Vue 文件格式化、标签自动闭合、Vue 2 代码片段 |

## 配置

**默认配置即可使用**，只在需要时写进项目的 `.vscode/settings.json`。

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `vueClick.definition.enabled` | `true` | 定义跳转 |
| `vueClick.completion.enabled` | `true` | 补全与自动导入 |
| `vueClick.languageService.enabled` | `true` | 项目语义分析（类型、引用、重命名） |
| `vueClick.formatting.enabled` | `true` | Vue 文件格式化 |
| `vueClick.diagnostics.enabled` | `false` | 活动文件自动诊断 |
| `vueClick.diagnostics.staticChecks` | `true` | 诊断中的模板成员与缺失资源检查 |

常改的两处：

```jsonc
{
  // 开启自动诊断；大项目可保持关闭，改用「检查当前文件」
  "vueClick.diagnostics.enabled": true,

  // 让 VueClick 接管 Vue 文件格式化
  "[vue]": {
    "editor.defaultFormatter": "jokeran.vueClick",
    "editor.formatOnSave": true
  }
}
```

- 用 Prettier 时把 `vueClick.formatting.enabled` 设为 `false`，不冲突。
- 路径别名写在 `jsconfig.json` / `tsconfig.json` 的 `compilerOptions.paths`，插件不执行 `vue.config.js`。
- 想用 `Tab` 展开 Emmet：`"emmet.includeLanguages": { "vue": "html" }`。

## 命令

- **VueClick: 检查当前文件** — 单次检查，不开启自动诊断
- **VueClick: 重启语言服务** — 补全或类型信息异常时重置
- **VueClick: 查看项目与服务状态** — 查看项目目录、诊断开关、线程状态

## 边界

- 专注 Vue 2（Options API 为主），不做 Vue 3 或完整 TS 语言服务。
- 静态分析只报能确定的问题：遇到 `mixins`、`extends`、`setup`、展开运算符、动态成员时直接跳过，不猜。
- 重命名 props 时父组件同步有上限（最多 200 个 `.vue`），超出部分不自动改名，宁漏不误。

[完整说明与边界](docs/usage.md) · [组件契约](docs/component-contracts.md) · [更新日志](CHANGELOG.md) · [第三方声明](ThirdPartyNotices.txt)
