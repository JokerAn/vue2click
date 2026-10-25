# Vue2Click

面向 Vue 2 的 VS Code 扩展，已在 JoyCode 验证。不依赖 Vetur 或 Vue - Official。

- Vue 文件高亮、定义跳转、成员与组件补全、代码片段。
- 类型悬停、参数提示、自动导入、查找引用与语义重命名。
- 组件 props / 事件 / 插槽提示，模板 class 到样式定位。
- HTML / CSS / SCSS / Less 编辑辅助、资源路径补全与格式化。

`F12` 或 Cmd/Ctrl + 点击跳转，`Ctrl+Space` 手动补全，`Ctrl/Cmd + .` 打开代码操作。输入 `vbase` 可生成 Vue 2 组件骨架。

## 关键配置

**默认即可使用，无需复制全部配置。** 只在需要调整时写入项目的 `.vscode/settings.json`。

| 配置项 | 默认值 | 功能 |
| --- | --- | --- |
| `vueClick.definition.enabled` | `true` | 定义跳转 |
| `vueClick.completion.enabled` | `true` | 补全与自动导入 |
| `vueClick.snippets.enabled` | `true` | Vue 代码片段 |
| `vueClick.languageService.enabled` | `true` | 项目语义分析、深层补全、类型提示、引用与重命名 |
| `vueClick.formatting.enabled` | `true` | 提供 Vue 文件格式化 |
| `vueClick.autoClosingTags.enabled` | `true` | 自动闭合标签，同时遵循 `html.autoClosingTags` |
| `vueClick.diagnostics.enabled` | `false` | 自动检查活动 Vue 文件的脚本、模板和样式 |

按需开启以下功能，合并到现有设置中：

```jsonc
{
  // 自动检查；大文件可保持默认关闭，使用下方命令手动检查
  "vueClick.diagnostics.enabled": true,

  // 保存时使用 VueClick 格式化 Vue 文件
  "[vue]": {
    "editor.defaultFormatter": "jokeran.vueClick",
    "editor.formatOnSave": true
  },

  // 使用 Tab 展开 div、ul>li*3 等 Emmet 缩写
  "emmet.includeLanguages": { "vue": "html" },
  "emmet.triggerExpansionOnTab": true
}
```

- 自动诊断需要语言服务保持开启；JS 类型检查还受 `jsconfig.json` / `tsconfig.json` 的 `compilerOptions.checkJs` 控制。
- 使用 Prettier 等格式器时，沿用其默认格式器，可将 `vueClick.formatting.enabled` 设为 `false`。
- 自定义路径别名写入 `jsconfig.json` / `tsconfig.json` 的 `compilerOptions.paths`；只读取保存后的配置，不执行 `vue.config.js`。原生映射目录提示需等待内置 JS/TS 服务及项目配置就绪。

## 常用命令

在命令面板中搜索：

- **VueClick: 检查当前文件**：单次检查，不开启自动诊断；需保持语言服务开启。
- **VueClick: 重启语言服务**：补全或类型信息异常时释放服务，下次请求重新启动。
- **VueClick: 查看项目与服务状态**：查看项目目录、诊断开关与线程状态。

[完整使用说明与边界](docs/usage.md) · [组件契约](docs/component-contracts.md) · [JoyCode 验证记录](docs/0.21.1-validation.md) · [更新日志](CHANGELOG.md) · [第三方声明](ThirdPartyNotices.txt)
