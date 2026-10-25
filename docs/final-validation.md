# 0.21.0 收尾验收

日期：2026-10-25。环境：macOS arm64、Node v24.21.0、本机 VS Code 1.143.1。

本版完成本轮既定范围：Vue 2 大文件的源码定位与 JSDoc 正确性、全局关系按文件失效，以及顺带支持独立 CSS/SCSS/Less 静态资源路径。不再以对齐其他语言扩展的功能数量作为后续目标。

## 完成范围与证据

| 范围 | 实现与验证 |
| --- | --- |
| 组件直接打开业务源码 | `src/components.js` 使用组件自身的 name / 导出锚点；`test/components.test.js` 回归源码目标和位置。 |
| 函数内部 JSDoc | `src/insight.js` 按声明作用域取说明，按语法树提取参数类型；`test/insight.test.js`、`test/hover.test.js` 覆盖箭头函数、多行与嵌套类型、局部变量隔离、引用处 range 和过期请求。 |
| `$refs` 与 `Vue.prototype` | `src/indirect.js`、`src/global-registry.js` 区分实例作用域、循环 ref 和唯一来源；单测覆盖方括号 ref、遮蔽、明确导出插件钩子和全局成员来源。 |
| 全局关系缓存 | 全局贡献按源码文件保存；`test/project-service.test.js` 覆盖编辑、关闭缓冲区、磁盘修改和新增/删除。单文件失效不重新加载全部候选源码。 |
| 按需服务 | 静态说明和样式路径不启动项目线程；真实编辑器 API 专项通过 `vueClick.showProjectInfo` 检查 `not-started`。自动项目诊断仍默认关闭。 |
| 独立样式资源 | `src/style-resources.js` 接入 CSS/SCSS/Less 定义、延迟解析链接和路径补全；`test/style-resources.test.js` 的 8 项测试覆盖相对路径、别名、唯一扩展名候选、未闭合字符串、配置变化、取消、文档版本变化及开关。 |
| 缓存和导入边界修复 | 样式缓存同时核对文档身份、版本与语言；按语句识别 import，覆盖注释、长空白和多个路径；解析既有链接前重新检查定义开关。 |
| 宿主与许可 | 构建实际加载 CommonJS 入口并精确核对 provider 注册，启动打包后的 Vue 2 worker；许可清单来自真实 bundle 输入，包含 29 个依赖条目。 |

## 最终验证结果

- `npm run package` 退出码 0：252 项测试，247 通过、5 跳过、0 失败；入口和 worker 检查通过；生成 `vueClick-0.21.0.vsix`。
- 74 个源码、脚本和测试 JavaScript 文件通过 `node --check`；package/lock JSON 可解析；`git diff --check` 通过。
- 本机 VS Code 1.143.1 的只读 API 专项退出码 0：普通 JS 跨文件 JSDoc、Vue 箭头函数参数，以及独立 CSS/SCSS/Less 的定义、链接解析和未闭合别名路径补全通过。确认上述操作未启动项目语义线程。
- 安装包 ZIP 完整性通过，JSON/XML 版本均为 0.21.0；117 个归档条目，3,546,639 字节。包内依赖许可清单 83,083 字节。归档不含 `src/`、`test/`、`scripts/`、`node_modules/` 或业务项目文件。

可复现命令：

```sh
npm run package
npm run benchmark:registry
npm run benchmark:file -- /Users/anshunli/jingDong/jdGit/apply-claim/src/views/apply/index.vue
VUECLICK_READ_TEST_ONLY=1 \
VSCODE_EXECUTABLE_PATH='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
npm run test:vscode
git diff --check
```

## 性能证据的实际范围

全局注册表的内存合成基准分别使用 2,000、5,000、10,000 个候选文件：首次加载全部候选；无修改再次查询加载 0 个；修改普通文件或插件文件后加载 1 个。更新仍枚举文件名并合并贡献。此结果不包含磁盘、IPC、编辑器 UI 或项目类型程序。

本机可用的旧业务 `index.vue` 为 5,418 行、181,127 字节。只读 Node 基准中，首次索引约 222.179 ms，复用索引后脚本定义查询 p95 约 0.465 ms，跨文件定义查询 p95 约 1.181 ms。共核验 13 份读取的源码和配置的 SHA-256 未变。结果受机器与运行状态影响，不能作为编辑器交互延迟承诺。

用户最新版超过 10,000 行的业务文件未在本机，未拉取、未同步，也没有声称实测过该版本。

## 已知边界与未验证项

- 5 项跳过测试依赖旧绝对业务样例及固定行号；样例不可用时保留跳过，不替换输入伪造通过。
- 本轮只读 API 专项不覆盖物理按键、建议列表接受、撤销或焦点相关操作；完整宿主套件保留焦点检查。本版未重新宣称完整操作验收通过。
- JoyCode 本机未安装，未实测；继续使用既有标准编辑器 API 和 CommonJS 打包。声明的最低 VS Code 1.90.0 本轮未单独启动验证。
- 独立样式仅处理明确静态 `@import`、`url()` 及静态别名；不实现完整 Sass/Less 构建器的 partial、index、包查找、变量或插值求值。候选不唯一时不选择首个文件。
- 全局注册首次相关查询仍枚举候选源码；静态安装钩子声明不代表实际执行了 `Vue.use`。动态注册、动态 ref 和无法唯一确认的来源维持保守行为。
- SFC 嵌入块按需创建缓存，文档版本变化仍会失效；没有实现跨版本块级增量解析。运行中的 TypeScript 同步任务也没有新增可中断保证。
- 格式化继续通过编辑器接口，可关闭以交给 Prettier；不改写 ESLint、Prettier 或用户保存设置。

完成上述代码与证据复核后，未发现本轮范围内仍待修复的已复现阻断问题。后续以实际日常使用中可复现的误跳、提示错误或明显卡顿驱动维护；不预先扩张到新的框架、路由、国际化或完整预处理器语言服务。
