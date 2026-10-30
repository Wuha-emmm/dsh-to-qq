# dev/

这些是开发期的辅助 bundle，**不随插件发布**，也不在 `package.json` 的 `files` 里。

## session-probe

一个只读诊断 bundle，注册 `qq_probe` 工具，用来确认「profile 里安装的 Host 插件能否直接调用 `ctx.sessionController` 的 `list / modelCatalog / inspect / resolveAgent / projections / follow`」。它是 [roadmap](../docs/roadmap.md) 第 1 项的实验证据。

## compat

空操作的 bundle，唯一作用是让 pnpm 把 `@deepseek-ai/cordis`、`dsh-llm` 等 Host 包装进 profile 的 `node_modules`，好让某些依赖它们的外部插件（例如 dsh-pet）能解析到。正常安装本插件不需要它。

两个都可以用 `plugin_manager` 的 `install_bundle` 单独安装，装完记得手动停用。
