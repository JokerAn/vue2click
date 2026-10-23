# VueClick 独立使用验证

## 0.2.1 修复与 JoyCode 兼容性复验

验证日期：2026-10-23。`npm run package` 通过 96 项测试、CommonJS 入口加载/注册检查及打包。新增回归用例覆盖：

- 模板三元分支、`return` / `await` 后的组件成员提示，保留对象键和声明位置过滤。
- URL 正则、含 `/*` 字符的正则后正常代码的补全，保留真正注释/字符串的过滤。
- `:[name]`、`@[event]`、完整指令及修饰符形式的表达式高亮。
- ES module 命名/默认/重命名导入、命名空间成员、转导出、局部遮蔽、循环/歧义/过深导出链、取消、文档修改失效及目标文件未保存修改。

真实编辑器分别在 VS Code 1.90.2、1.141.0，以及 `/Applications/JoyCode IDE.app` 3.0.12 中运行。JoyCode 报告的扩展 API 版本为 1.98.2。三个环境均通过激活、定义跳转、补全、片段展开、区域注释和实际高亮分词验证。未加载 Vetur 或 Vue - Official。

指定大文件的 `sgmCodeF`：导入处第 1299 行，以及调用处第 2105、2369、2852、3942、4373、4953 行，均通过真实编辑器命令跳到 `src/config/mUtils.js` 第 1031 行的函数名。父文件和目标业务文件均保持未修改。

入口以 `--format=cjs --platform=node --target=node18 --external:vscode` 明确打包，未声明 `"type": "module"`。构建检查通过 CommonJS 的 `require('vscode')` 加载实际 bundle，验证 `activate` / `deactivate` 及跳转、补全提供者注册。安装包不含 `node_modules`、其他编辑器扩展依赖、项目工具配置、源码、测试或测试用户配置。

JoyCode 复现命令：

```sh
VSCODE_EXECUTABLE_PATH='/Applications/JoyCode IDE.app/Contents/MacOS/JoyCode' \
VUECLICK_TEST_FILE='/Users/anshunli1/jd/jdGit/备份/不可删除/apply-claim/src/views/apply/index.vue' \
npm run test:vscode
```

以下为 0.2.0 首轮基准记录，保留用于对照；具体耗时属于有限样本，不构成不同宿主或版本的性能承诺。

## 0.2.0 首轮基准

验证日期：2026-10-23。环境为 macOS Apple Silicon、Node v24.21.0，以及真实 VS Code 1.90.2 / 1.141.0 扩展宿主。

## 验证范围

扩展宿主使用独立临时配置，禁用其他用户扩展，并断言 Vetur 与 Vue - Official 未加载。验证 `.vue` 文件识别、JS/TS/CSS 和模板高亮分词、区域注释、组件成员补全、裸 `<` 的组件提示、裸 `:` 的 props 提示、代码片段实际展开、定义跳转、未保存子组件 props 和功能开关。

`npm run package` 通过 85 项测试、构建及 VSIX 打包。解析测试包含已有跳转回归、作用域/this 别名、模板局部变量、取消、文档版本失效、并发共享读取和缓存淘汰。TextMate 测试使用真实正则引擎，覆盖分行 `lang` 属性、嵌套模板及块间切换。

安装包 `vueClick-0.2.0.vsix` 约 1.21 MB，没有扩展依赖。复用了 Vetur 的模板语法规则，保留来源和许可；未引入 Vetur 语言服务器。

## 指定真实文件

文件：

```text
/Users/anshunli1/jd/jdGit/备份/不可删除/apply-claim/src/views/apply/index.vue
```

9,282 行，330,025 字节，302,976 个 UTF-16 字符。解析到 388 处模板表达式。跨文件测试命中 15 个组件文件、152 处组件/props 引用，其中 124 处为 props 引用。

Node 基准核对了成功读取的 17 个源码/配置文件的 SHA-256。真实编辑器测试同时核对业务文档未标为修改、编辑器文本和磁盘文本哈希一致。业务项目未写入文件；编辑、片段插入和未保存 props 场景仅发生在临时样例中。

## Node API 基准

模块首次加载约 84.95 ms，首次构建文件索引约 43.16 ms。预热后 10 次完整重建的中位数为 17.16 ms，P95 为 24.13 ms。

| 操作 | 次数 | 中位数 | P95 |
| --- | ---: | ---: | ---: |
| 模板定义跳转 | 1,000 | 0.007 ms | 0.012 ms |
| 脚本定义跳转 | 1,000 | 0.331 ms | 0.351 ms |
| 模板成员补全 | 500 | 0.073 ms | 0.087 ms |
| 脚本成员补全 | 500 | 0.392 ms | 0.422 ms |
| 跨文件定义跳转 | 100 | 0.278 ms | 0.349 ms |
| 子组件 props 补全 | 60 | 0.293 ms | 0.322 ms |

本地查询分散于不同位置，模板验证了 410 处可跳转引用，脚本验证了 1,492 处可跳转引用。跨文件查询复用源码索引，但每个请求重新创建路径/配置解析会话。结果不包含编辑器通信和渲染。

首次扫描全部组件/props 引用的总耗时约 50.13 ms；这是整批覆盖扫描时间，不是单次操作延迟。

## 真实 VS Code 命令基准

以下结果包含扩展宿主与编辑器命令之间的通信。每版测试中本地跳转 60 次、成员补全 60 次、跨文件 props 跳转 30 次，位置分散于真实文件。

| 操作 | VS Code 1.141.0 中位数 / P95 | VS Code 1.90.2 中位数 / P95 |
| --- | ---: | ---: |
| 本地定义跳转 | 0.300 / 0.679 ms | 7.478 / 14.776 ms |
| 组件成员补全 | 1.120 / 1.581 ms | 1.925 / 4.173 ms |
| 跨文件 props 跳转 | 0.888 / 4.495 ms | 0.829 / 3.970 ms |

文件打开命令耗时分别约 47.01 / 41.16 ms。完整遍历 9,282 行、加载内置语法并进行 TextMate 分词的测试耗时分别约 388.94 / 529.93 ms；这不是每次按键重算的耗时，也不是编辑器完成绘制的时间。

上述数据来自同一机器的单次有限样本运行，会受到编辑器启动任务、后台分词和调度影响，不作为跨机器性能承诺或严格的版本性能比较。未以自动化方式验证 Windows/Linux、长时间输入或长期堆内存增长。

## 复现

业务文件只读的 Node 基准：

```sh
npm run benchmark:file -- '/Users/anshunli1/jd/jdGit/备份/不可删除/apply-claim/src/views/apply/index.vue'
```

本机 VS Code 独立测试：

```sh
VSCODE_EXECUTABLE_PATH='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
VUECLICK_TEST_FILE='/Users/anshunli1/jd/jdGit/备份/不可删除/apply-claim/src/views/apply/index.vue' \
npm run test:vscode
```

1.90 系列兼容性验证：

```sh
VSCODE_TEST_VERSION=1.90.2 \
VUECLICK_TEST_FILE='/Users/anshunli1/jd/jdGit/备份/不可删除/apply-claim/src/views/apply/index.vue' \
npm run test:vscode
```
