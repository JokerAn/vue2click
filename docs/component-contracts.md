# 组件契约与元数据

VueClick 使用通用解析读取业务组件和组件库的信息。定义跳转、补全与悬停按请求读取数据，不执行项目代码，不在打开文件时预热所有组件。

## 源码优先

当前文件明确注册的组件优先；随后尝试静态全局注册，最后查找元数据。源码中的运行时 props、默认值、JSDoc、静态事件以及 mixin/extends 继续支持。

类型契约支持同文件类型别名、接口继承、无冲突交叉类型、普通和 type-only 导入、导入别名、命名转导出及无歧义的 export-star。属性字面量别名可以跨文件提供候选值。解析每次最多 256 步、24 层，遇到循环、冲突或无法确定的交叉分支时停止推断，不靠执行代码获取结果。

泛型实例化、utility/mapped/conditional 类型和 `withDefaults` 本次没有扩展。这里描述的是独立静态契约解析，不是 TypeScript 语义服务的完整支持范围。

## 复用组件库的数据

已安装依赖可以在自己的 `package.json` 声明：

```json
{
  "vetur": {
    "tags": "metadata/tags.json",
    "attributes": "metadata/attributes.json"
  }
}
```

业务项目也可以用同一格式声明元数据。例如：

```json
{
  "acme-card": {
    "description": "业务卡片。",
    "attributes": ["mode", "enabled", "saved"]
  }
}
```

对应属性文件：

```json
{
  "acme-card/mode": {
    "type": "string",
    "options": ["edit", "view"]
  },
  "acme-card/enabled": {
    "type": "boolean",
    "options": [true, false]
  },
  "acme-card/saved": {
    "type": "event",
    "description": "保存成功后触发。"
  }
}
```

`type: "event"` 进入事件提示，不混在 props 中。选项的 JSON 原始类型保留：`false` 与 `"false"` 的表达式文本不同。静态字符串属性只提供字符串选项。属性文件也支持全局属性键；按 Vetur 格式，全局键优先于 `组件名/属性名`。

相同组件的元数据优先级为项目声明、已安装包自带数据、内置基础兜底，按整个组件条目覆盖。损坏 JSON 或异常条目不会影响其它健康组件。不同库的同名组件仍建议用项目声明明确选择，不能靠名字猜来源。

## 缓存与刷新

元数据首次需要时读取并缓存，不在连续补全中重读所有依赖清单。项目内 JSON 文件通过文件变化通知刷新；使用其它扩展名的元数据在编辑器保存后刷新。依赖安装升级、工作区外文件修改或外部工具改写非 JSON 元数据后，可运行 **VueClick: 重启语言服务**。

组件源码契约最多缓存 64 个结果，任意相关项目版本变化都会重新读取。内置 Element UI 2 和 Vue Router 3 是有限兜底；不会因本项目使用某个库而在扩展中不断新增手工 API 表。
