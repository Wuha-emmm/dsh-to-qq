# 本地肥鱼声音（可选）

一句话：让 `qq_voice` 用**她自己的声音**念，而不是 DeepSeek 的 `stella`；
再往上，还能按谱唱、以及把一首歌换成她的声音唱。

装在本机、完全离线推理；关掉开关就当没装过。

配套仓库：[astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice)（本仓库只借用它的 `server/` 与三个权重包，AstrBot 那部分不用）。

## 三个引擎

| 引擎 | 作用 | 磁盘 | 常驻显存 | 一句/一首的效果 |
|---|---|---|---|---|
| **TTS**（CosyVoice3 0.5B） | 文字 → 她的声音 | ≈ 7.4 GB | 约 3.5 GB | 断句、呼吸、语气都是她的；cute / gentle 两条参考音 |
| **RVC**（Applio + FeiyuVoice-RVC） | 任意人声 → 她的音色 | ≈ 0.5 GB | 约 0.9 GB | 音色是她的，语气跟着原声走 |
| **SVS**（SoulX-Singer） | 乐谱 + 歌词 → 唱歌 | ≈ 2.6 GB | 按需 | 按 MIDI 唱，再叠 RVC 换音色 |

三个可以任意组合。只装 RVC 时，一句语音是「DeepSeek 合成原声 → RVC 换音色」，便宜但语气是原声的；
装上 TTS 后直接用她的模型说话；SVS 让「翻唱」成立（见下文「唱歌与翻唱」）。

## 为什么不用 WSL

上游安装脚本只允许 Intel XPU 走原生 Windows，CUDA 一律塞进 `wsl.exe`。但 `feiyu_runtime/common.py`
本来就有 `host: "windows"` 的支持（torchaudio 用 soundfile 解码、路径不做 Linux 映射），
所以这里为三个引擎各写一份 `host: "windows"` 的运行时档案，引擎在 Windows 的 venv 里跑——
不需要 WSL、不需要重启、不占十几 GB 的 Linux 环境。

## 目录布局（默认 `E:\feiyu`）

```
E:\feiyu
├─ server\                                上游 server/（FastAPI 队列 + feiyu_runtime 适配层）
│  ├─ configs\voice_service.json           ← 服务配置（TTS / RVC / singing 三块）
│  ├─ configs\singing.json                 ← 唱歌配置（SVS 权重、音素表、参考音）
│  └─ configs\runtime.{rvc,tts,svs}.cuda.local.json ← 本机运行时档案
├─ envs\service\                          只跑队列：fastapi/uvicorn + mido/music21，没有 torch
├─ envs\rvc\                              torch 2.11.0+cu128 + Applio 依赖
├─ envs\tts\                              torch + CosyVoice 依赖（onnxruntime/whisper/x-transformers…）
├─ envs\svs\                              torch + SoulX-Singer 依赖
├─ applio\                                IAHispano/Applio @ 67a38f6，打上上游补丁层
├─ cosyvoice\                             FunAudioLLM/CosyVoice @ 074ca6d（含 Matcha-TTS 子模块）
├─ soulx\                                 Soul-AILab/SoulX-Singer @ 81aeb3a
├─ models\FeiyuVoice-RVC\                 RVC 权重包（约 136 MB，带 sha256 清单）
├─ models\FeiyuVoice-CosyVoice3\          TTS 权重包（约 7.4 GB，31 个文件全量校验）
├─ models\SoulX-Singer\model.pt           SVS 权重（2.6 GB）
└─ assets\singing\{prompt.wav,prompt.json} 唱歌参考音（10.69 s，带 F0 标注）
```

`server\configs\voice_service.json` 同时列出三块；缺哪块，`/v1/capabilities` 就少报哪个引擎。

## 安装（实际步骤）

```powershell
# 1. uv 与三个 Python 3.11 环境（不用系统 Python）
python -m pip install --prefix E:\feiyu\uvprefix uv
E:\feiyu\uvprefix\Scripts\uv.exe venv --python 3.11 E:\feiyu\envs\service
E:\feiyu\uvprefix\Scripts\uv.exe venv --python 3.11 E:\feiyu\envs\rvc
E:\feiyu\uvprefix\Scripts\uv.exe venv --python 3.11 E:\feiyu\envs\tts
E:\feiyu\uvprefix\Scripts\uv.exe venv --python 3.11 E:\feiyu\envs\svs

# 2. 服务本体（CPU，无 torch）
E:\feiyu\uvprefix\Scripts\uv.exe pip install --python E:\feiyu\envs\service\Scripts\python.exe `
  -r E:\feiyu\server\requirements-service.txt

# 3. torch：别死磕一个镜像，先拿 8 MB range 探速（NJU 镜像实测 7 MB/s）
#    https://mirrors.nju.edu.cn/pytorch/whl/cu128/ → torch / torchaudio 2.11.0+cu128
E:\feiyu\uvprefix\Scripts\uv.exe pip install --python E:\feiyu\envs\rvc\Scripts\python.exe `
  E:\feiyu\dl\torchaudio-2.11.0+cu128-cp311-cp311-win_amd64.whl E:\feiyu\dl\torch-2.11.0+cu128-cp311-cp311-win_amd64.whl
E:\feiyu\uvprefix\Scripts\uv.exe pip install --python E:\feiyu\envs\rvc\Scripts\python.exe `
  -r E:\feiyu\server\runtime_profiles\requirements-rvc-windows.txt

# 4. TTS / SVS 依赖（同一个 torch wheel，装进各自环境）
E:\feiyu\uvprefix\Scripts\uv.exe pip install --python E:\feiyu\envs\tts\Scripts\python.exe `
  -r E:\feiyu\dl\requirements-tts-windows.txt
E:\feiyu\uvprefix\Scripts\uv.exe pip install --python E:\feiyu\envs\svs\Scripts\python.exe torch torchaudio `
  --index-url https://mirrors.nju.edu.cn/pytorch/whl/cu128
# SoulX 依赖：numpy/scipy/librosa/soundfile/omegaconf/transformers==4.41.2/accelerate/einops/tqdm

# 5. 源码三个（都用固定提交）
git -C E:\feiyu\applio checkout 67a38f6abab3e90a55efa534ea3185a222c102f0
git -C E:\feiyu\cosyvoice checkout 074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
git -C E:\feiyu\soulx checkout 81aeb3ae772c70093c3de74dc23c92d983801ae4
Copy-Item E:\feiyu\server\runtime_compat\Applio\* E:\feiyu\applio -Recurse -Force

# 6. 运行时档案（等价于 setup_runtime.py 成功后的产物）
E:\feiyu\envs\service\Scripts\python.exe E:\feiyu\build-profile2.py rvc
E:\feiyu\envs\service\Scripts\python.exe E:\feiyu\build-profile2.py tts
E:\feiyu\envs\service\Scripts\python.exe E:\feiyu\build-profile2.py svs
```

权重包从 ModelScope 下（本机实测 9–19 MB/s）：`Esmerubphire/FeiyuVoice-RVC`、
`Esmerubphire/FeiyuVoice-CosyVoice3`、`Soul-AILab/SoulX-Singer`（`model.pt` 用 16 MB 分块续传，
长连接会中途卡死）。

`requirements-rvc-windows.txt` 和上游只差一个 pin：`faiss-cpu==1.9.0.post1`（上游写 1.14.3，但
1.10 之后不再发布 win_amd64 轮子）。1.9.0.post1 是最后一版 Windows 构建，numpy 2 下能读权重包里的
`v1.index`——10132 条、768 维，实测 `search` 正常。

TTS 环境里 **`wetext` 被改名禁用**（`python -m pip` 装的 `wetext` 会去 ModelScope 拉 FST 模型，
那个仓库现在 403）。CosyVoice 的 `frontend.py` 本来就有「没有文本前端也能跑」的回退分支
（`text_frontend = ''`），实测正常出音；代价是数字不会自动读成中文——`qq_voice` 侧会先把阿拉伯数字
念出来再送进去。

`build-profile2.py` 把源码里所有 `.py/.json/.yaml/.toml` 的 sha256 写进档案，服务启动时逐个复核；
`git rev-parse HEAD` 也必须等于提交号。引擎目录被改过一个字节，任务会直接失败而不是悄悄跑错。

## 启动与验证

```powershell
# 手动起一次（首次启动把 api_key 写到 .runtime\voice-service\api_key.txt）
E:\feiyu\envs\service\Scripts\python.exe -B -m feiyu_voice_service --host 127.0.0.1 --port 9880 `
  --config E:\feiyu\server\configs\voice_service.json
```

```powershell
$key = (Get-Content E:\feiyu\server\.runtime\voice-service\api_key.txt -Raw).Trim()
Invoke-RestMethod http://127.0.0.1:9880/health                                  # 无需鉴权
Invoke-RestMethod http://127.0.0.1:9880/v1/capabilities -Headers @{Authorization="Bearer $key"}
# → tts[{voice:"feiyu",styles:["cute","gentle"]}] rvc[...] singing{available:true,formats:["midi","abc"]}
```

三种任务同一个协议：`POST /v1/speech {voice,text,style}`、`POST /v1/voice-conversion {voice,audio_id}`
（先 `POST /v1/assets` 传 wav）、`POST /v1/singing {voice, score(上传后的 audio_id), lyrics}`；
都返回 202 + `id`，轮询 `GET /v1/jobs/{id}` 到 `success`，再 `GET /v1/jobs/{id}/audio`。

常驻模式不走上面这套 HTTP，直接跟插件自带的 worker 对话（stdin/stdout 各一行 JSON）：

```powershell
'{"op":"ping"}' | E:\feiyu\envs\rvc\Scripts\python.exe E:\DSH-to-QQ\python\feiyu_warm_server.py `
  --root E:\feiyu --device cuda:0 --no-prewarm
'{"op":"ping"}' | E:\feiyu\envs\tts\Scripts\python.exe E:\DSH-to-QQ\python\feiyu_tts_server.py `
  --package E:\feiyu\models\FeiyuVoice-CosyVoice3 `
  --profile E:\feiyu\server\configs\runtime.tts.cuda.local.json --server E:\feiyu\server
```

## 开关

设置页「语音」组里有三个勾选框，语义都是「关掉 = 进程退出、显存归零、当没装过」：

| 键 | 默认 | 作用 |
|---|---|---|
| `speech.local.enabled` | 关 | 总闸。关 = 不启动任何进程，`qq_voice` 走 DeepSeek 原声 |
| `speech.local.warm` | 开 | 变声常驻（0.2 s/句，约 900 MB 显存）；关 = 每句起进程（10 s） |
| `speech.local.ttsWarm` | 开 | 用她的声音说话（1–3 s/句，约 3.5 GB 显存）；关 = 回落 DeepSeek 原声 |

`idleStopMinutes` 分钟没有语音，两个常驻进程一起退出（0 = 一直常驻）；
`qq_voice_service stop` 也会 `taskkill /T /F` 掉整棵进程树。

两种运行模式，用 `speech.local.warm` 切：

| | 常驻预热（`warm: true`，默认） | 按句起进程（`warm: false`） |
|---|---|---|
| 一句变声 | **0.12–0.2 s** | 约 10 s |
| 一句话（TTS） | **1–3 s** | 约 30 s（含 16 s 模型加载） |
| 进程 | `python\feiyu_warm_server.py` + `python\feiyu_tts_server.py` | 服务每 job 起一个短命 worker |
| 显存 | 约 4.4 GB（0.9 + 3.5） | 跑完即退 |

常驻模式下 `qq_voice` 优先用她的 TTS（`provider: feiyu-tts`）；`ttsWarm` 关掉时回落到
「DeepSeek 原声 + RVC 变声」（`provider: feiyu-rvc`）；两个都不可用就用原声（`provider: deepseek`）。
不会偷偷退回 30 秒的队列路径。

## 延迟（RTX 5070，实测）

| 场景 | 实测 |
|---|---|
| RVC 常驻每句 | **121 / 143 / 199 ms** |
| RVC 常驻启动（加载 + 预热） | 7.05 s |
| RVC 按句起进程 | 10.05–10.07 s |
| TTS 常驻每句（2.4 s 音频） | **1.89–1.98 s**（RTF ≈ 0.65） |
| TTS 常驻启动（加载 16.0 s + 预热 3.6 s） | 19.7 s |
| TTS 按句起进程 | 30.3 s（推理 20.7 s，其余是加载） |
| SVS+RVC 唱 8 秒（小星星，14 音） | 53 s（SVS 36.8 s + RVC 12 s） |

RVC 的 10 秒里几乎没有推理：真正的网络前向在热进程里是 **0.13 s**，其余是每句重开进程要付的
torch 导入、Applio 模块、`get_vc` 和 CUDA 上下文初始化。TTS 的 20.7 s 里也有一半是首次内核初始化，
常驻后每句只剩 1.9 s。

磁盘：`E:\feiyu` 装完三个引擎约 **33 GB**（envs 14.5 / models 9.7 / dl 3.3 / uv-cache 5.4 /
源码 1.5）。`uv-cache` 与 `dl` 装完可删，约省 8.5 GB。

## 唱歌与翻唱

上游 `feiyu_singing` 支持「乐谱 → SVS → RVC」：给一个 MIDI/ABC 和歌词，SVS 按谱合成歌声
（24 kHz），再经 RVC 换成她的音色（40 kHz），产物 `singing.wav` + `试听与对齐.html`。
小星星实测：14 个音、8 秒、1 段，53 秒出结果。

整首歌的翻唱（「原曲 → 她的声音」）上游没有现成实现，这里补了一条链，跑在同一个
`E:\feiyu` 安装上：

```
原曲 ──demucs(htdemucs_ft)──► 人声 + 伴奏
                                  │        │
                                  │        └──────────────┐
                                  ▼                       │
                          FeiyuVoice-RVC                  │
                          （保留原旋律和节奏，只换音色）    │
                                  │                       │
                                  ▼                       ▼
                              混音（人声 + 伴奏）──► cover.wav / cover.mp3
```

一条命令（Python 侧）：

```powershell
E:\feiyu\envs\rvc\Scripts\python.exe E:\feiyu\cover.py `
  --input 某首歌.mp3 --output E:\feiyu\out\cover.wav --mp3
```

中间产物（`vocals.wav`、`instrumental.wav`、`rvc/rvc_native.wav`）留在
`<歌曲所在目录>\<歌名>-cover\`，改混音比例时加 `--stems` 复用，不用重跑分离
（`--vocal-gain` / `--instrumental-gain` 调比例）。8 秒的小星星实测：分离十几秒、
RVC 5.5 秒；整首歌 3 分钟大概 2–4 分钟。

插件侧对应工具是 `qq_cover`（管理员、群聊可用）：给一个本地音频路径，它跑同一条链，
返回 mp3 的路径，再用 `qq_send` 把文件发出去。整首歌装不进语音条，必须按文件发；
`coverTimeoutMs` 默认 30 分钟。

demucs 的权重是 htdemucs_ft 里的单个子模型 `d12395a8-e57c48e6.th`（80 MB，放在
`E:\feiyu\models\demucs\`）。文件名里的 `e57c48e6` 就是 sha256 前缀，demucs 自己会校验，
所以这个文件从镜像站下也一样。官方 `dl.fbaipublicfiles.com` 在本机只有 0.1–0.4 MB/s，
镜像反而能到 1 MB/s 以上。

## 排错

| 现象 | 原因 |
|---|---|
| `缺 demucs 权重` | `E:\feiyu\models\demucs\` 里没有 `<签名>-<sha前缀>.th`，或文件名被改过（demucs 靠文件名里的前缀校验） |
| `翻唱失败（退出码 1）` 且日志里是 `CUDA out of memory` | 变声和 TTS 常驻同时在跑；先 `qq_voice_service stop` 再做整首翻唱 |
| `本地声音服务起不来` | 看 `E:\feiyu\server\.runtime\voice-service\service.log`；端口被别的实例占了也会这样 |
| `Package integrity check failed` | 权重包缺文件或被改过，重下 `files_sha256.json` 里列的文件 |
| `Configured Applio runtime differs…` | `applio` 里的补丁层没打全，或换了提交号；重跑第 5 步 |
| `PyTorch version differs` | venv 里的 torch 不是 `2.11.0+cu128`，或档案里的版本号写错 |
| `Runtime source changed: xxx.py` | 引擎源码被改过；改了就重跑 `build-profile2.py`（会重写指纹） |
| `ModuleNotFoundError: diffusers / lightning / gdown` | TTS 环境少装依赖，按 `requirements-tts-windows.txt` 补齐 |
| `TextEncodeInput must be…` | 常驻 TTS 的 stdin 不是 UTF-8；worker 里用 `TextIOWrapper(sys.stdin.buffer, "utf-8")` 修掉 |
| TTS 401/403 且日志提到 `modelscope` | `wetext` 在拉 FST 模型；把 site-packages 里的 `wetext` 改名禁用 |
| 任务 `failed` 且 `worker.log` 提到 CUDA | 驱动/CUDA 版本不够，`nvidia-smi` 确认；RTX 50 系必须 cu128 及以上 |

## 与上游的差异

- 不改上游代码，只在外部提供 `host: "windows"` 的运行时档案（上游 `validate_profile` 本来就认）。
- `faiss-cpu` 换成 1.9.0.post1（上游 pin 的 1.14.3 没有 Windows 轮子），其余依赖版本照旧。
- 上游 `setup_runtime.py` 在 Windows 上只允许 `--backend xpu`；本仓库用 `build-profile2.py` 绕过这个
  限制，装法等价，校验不变。
- 上游没有常驻 worker（每个 job 重开进程，RVC 10 s/句、TTS 30 s/句）；插件自带
  `python/feiyu_warm_server.py` 与 `python/feiyu_tts_server.py`，复用同一份权重，把模型留在显存里。
  两者都跑上游的 manifest/sha256 校验，不复制任何权重。
- TTS 环境的 `wetext` 被禁用（模型仓库 403），改走 CosyVoice 自带的「无文本前端」回退。
