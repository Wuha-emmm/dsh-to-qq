# 安装（一键 / 手动）

三种方式，选一种就行。**推荐第一种**：两步，出错最少。

## 一键：双击 `setup.cmd`

```
仓库根目录
  └─ setup.cmd          ← 双击
```

它做四件事：

1. 找到 DSH 自带的 Node（从注册表定位安装目录，不依赖 PATH）
2. 用 DSH 自带的 pnpm 打包出 `dist\dsh-to-qq-<版本>.tgz`
3. 检查 SnowLuma 是否装好、是否登录过小号
4. 把安装指令复制到剪贴板，并打印在窗口里

然后**把那句话粘给 DSH**（任意会话都行）：

```
请帮我安装本地插件包，装完提醒我重启 DSH：

file:///C:/你的路径/dsh-to-qq/dist/dsh-to-qq-<版本>.tgz
```

DSH 会用它的 `plugin_manager` 完成安装——这一步必须由 DSH 自己做，因为它要同时改 profile 的 `package.json` 和 Cordis 补丁；外部脚本硬改容易把 profile 弄坏。

装完 **重启 DSH** → 打开「设置 → QQ 桥接」。

### 参数

| 参数 | 用途 |
|---|---|
| `-Open` | 装之前顺手启动 DSH |
| `-DshDir "D:\DeepSeek Harness"` | 自动找不到 DSH 时手动指定 |
| `-SnowLumaDir "D:\SnowLuma"` | 自动找不到 SnowLuma 时手动指定 |

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Open
```

## 手动（三步）

```powershell
# 1. 打包（DSH 自带的 pnpm 也行）
pnpm pack --pack-destination dist

# 2. 在 DSH 里让它安装
#    把这句发给 DSH：请安装这个插件包 file:///<绝对路径>/dist/dsh-to-qq-<版本>.tgz

# 3. 重启 DSH → 设置 → QQ 桥接
```

## 只装插件、还没装 SnowLuma

插件能装上，但连不上 QQ。按 [部署指南](deploy.md) 的顺序来：先 SnowLuma 扫码登录小号，再填 token。

## 装完自检

| 检查 | 期望 |
|---|---|
| DSH 设置里出现「QQ 桥接」 | ✅ |
| 连接页签显示绿色「已连接」 | ✅ |
| 私聊发「在吗」 | 几秒内回复 |
| `qq_status` | `transport online`、`images ok` |

不通过就看 [排障](troubleshooting.md)。

## 卸载

在 DSH 里让插件管理器移除 `dsh-to-qq`，或 `plugin_manager remove_bundle`。状态数据在 `~/.dsh/dsh-to-qq/`，要彻底清干净需手动删（**里面有 token 和聊天记录**）。
