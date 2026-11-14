# 后续优化的落地可行性与实施方案

本文对照 v0.2.7 源码，判断上一轮架构评审里的优化项能不能在现有结构里做完，以及第一刀该改哪些函数。结论按「可落地 / 分步做 / 暂缓」三档，不按日历排期。

可落地的五项已经写进代码：共享路径约束（`sharer.js`）、日志 2MB 轮转（`log.js`）、进程枚举改为 CIM（`emulator.js`）、接管时只有 offline 记录才 `kill-server`（`engine.js`）、安装成功后才作废快照并在空闲或接管关机前补存。分步项和暂缓项没有改。

统计与阅读范围：`src/main.js`、`src/ui/app.js`、`src/core/*`、`src/core/win/*`、`test/auto-test.js`、`.github/workflows/ci.yml`。CI 在 `windows-latest` 上跑 `npm test` 和鼠标钩子冒烟，不启动 Android。

## 总判

| 项 | 判定 | 第一刀 |
|---|---|---|
| 拆 `main.js` / `app.js` | 分步做 | 先抽会话与 IPC，界面用多个经典脚本，不引入打包器 |
| 遗留 QEMU / ISO 引擎 | 隔离可落地，删除暂缓 | 搬到独立模块；默认开机只走官方 Emulator |
| 启动热路径少起 adb 进程 | 可落地 | 另开一条常驻 shell，命令白名单，不和滚轮共用 |
| 返回 / 滚轮改走模拟器控制台 | 分步做 | 本机 TCP 控制台，失败回退现有 `adb input`；不引入 gRPC |
| 安装后补存 quickboot | 可落地 | 安装成功后再作废旧快照，空闲和接管关机前执行已有的 `snapshot save` |
| 共享目录 | 路径加固可落地；事件同步分步；目录挂载暂缓 | 先让 `mkdir` 不再把未约束路径拼进 shell |
| 用安卓多用户做隔离 | 暂缓 | 保持单用户、单窗口 |
| `app.log` 滚动 | 可落地 | 超过 2MB 轮转一份 |
| `wmic` 换 CIM | 可落地 | 孤儿进程枚举改到已有的 PowerShell |
| 收窄 `adb kill-server` | 可落地 | 接管路径只处理 offline 记录；冷启动保留清 server |
| 打开 `sandbox` | 分步做 | 先只改应用壳窗口，在 Windows 上走一遍嵌入和拖放 |

建议的合入顺序：路径加固、日志、`wmic`、`kill-server` 互不依赖，可以各自一个小改动。快照补存紧随其后。常驻查询 shell、控制台输入、拆文件、QEMU 隔离各自独立合入，不要和上面的行为改动混在同一个 diff 里。

## 1. 拆分 main.js 与 app.js

判定：分步做。纯搬家，行为可以保持不变，但一次拆完无法评审。

依据：

- `src/main.js` 1218 行，其中 `ipcMain.handle` 有 74 处，外加单实例、托盘、`runLaunch` / `runInstall`、窗口生命周期。
- `src/ui/app.js` 1092 行，部署向导、应用库、设置、安卓设置都在同一个闭包里。
- `src/ui/index.html` 的 CSP 是 `script-src 'self'`。多个同源经典脚本可以直接加，不需要打包器。`file://` 下的 ES Module 在 Electron 里额外受 CORS 影响，这一轮不要改成 `type="module"`。
- 现有测试几乎不 import `main.js`。拆分的验收是 `npm test` 仍过，加上 Windows 上一次 `--smoke` 和一次 `--launch`。

实施方案：

1. 抽出 `src/session.js`，只放 `runLaunch`、`runInstall`、`openAppWindow`、`onContainerActive`。依赖从参数传入：`runtime`、`installer`、`appWin`、`store`、`send`。`main.js` 只负责创建这些对象并调用。
2. 按域注册 IPC，而不是按文件大小切：`src/ipc/apps.js`、`src/ipc/runtime.js`、`src/ipc/settings.js`。每个文件导出 `register(ipcMain, ctx)`。通道名保持不变，`preload.js` 不动。
3. 界面按现有函数边界切成 `src/ui/format.js`（`esc`、`toast`、`fmtSize`）、`src/ui/setup.js`、`src/ui/library.js`、`src/ui/settings-page.js`，在 `index.html` 里按顺序用 `<script src>` 引入。共享状态放一个 `window.apkstartState`，避免隐式全局互相覆盖。
4. 应用壳 `shell.js` 只有约 50 行，保持不动。

风险：`runLaunch` 闭包依赖 `wheelRouter`、`deviceSize`、`currentAppPkg`。搬家时这些状态跟会话走，不要留在 `main.js` 再绕回去。拆分 PR 里不改启动条件、不改 IPC 参数形状。

## 2. 遗留 QEMU / ISO 引擎

判定：隔离可落地。从仓库里删掉暂缓。

依据：

- 默认开机在 `Runtime.boot()`：`env.emulator.ok && env.sysimg.ok` 时走 `bootEmulator()`。QEMU 路径是 `bootQemu()`，由 `buildArgs()`、`monitorCmd()`、`startInstaller()`、`markInstalled()` 支撑，大约集中在 `engine.js` 的 200–540 行。
- `Runtime.ensure()` 在官方组件不齐、且 `settings.runtime.installed === true` 时仍会落到 `boot()`，从而进入 QEMU。这是升级用户可能还在用的路径，不是不可达死代码。
- 部署向导 `renderSetup()` 已经只渲染「一键完成」。`runStep('qemu'|'iso'|'disk')`、`startInstall()`、`importIso`、`importDisk` 仍挂在点击委托上，只是当前向导不再画出这些按钮。
- 设置页仍保留 ISO 路径输入框。引擎模式下拉的文案仍写着「QEMU + Android-x86」，和实际默认的官方 Emulator 不一致。
- `provision.js` 里 ISO、磁盘、QEMU 安装包的下载和 `test/boot-test.js` 的 Alpine guest 都还在。删模块会同时拆掉这条测试。

实施方案：

1. 把 `buildArgs`、`bootQemu`、`monitorCmd`、`sendKey`、`startInstaller`、`markInstalled`、只被 QEMU 使用的 `waitAndroidReady` 移到 `src/core/qemu-legacy.js`。`engine.js` 保留一个方法转调。
2. `ensure()` 里官方 Emulator 不可用时，仅当 `settings.runtime.legacyQemu === true` 或已经存在 `runtime.installed` 标记时才转调。新用户的默认结果是「组件未就绪」，走现有部署向导。
3. 设置页那一行选项改成「自带 Android 运行时」。ISO 输入框收进明确标为旧路径的折叠区。
4. 删除下载逻辑和 Alpine 启动测试放到后续单独改动，先确认没有发行版用户仍依赖 `runtime.installed` 的磁盘启动。

风险：`boot()` 今天被两处调用，搬迁时保持返回值 `{ ok, error, client, install }` 的形状，UI 的 `runtime:startInstaller` 不用改协议。

## 3. 启动热路径少起 adb 进程

判定：可落地。模式已经在输入通道里验证过。

依据：

- `AdbClient.input()` 已经维持一条 `adb shell`，用整行等于 `__APKSTART_<id>__` 的回显做完成信号，并处理了 shell 把命令本身回显出来的情况。
- 这条通道被 `pointer.js` 的 `INPUT_RE` 限制为 `input keyevent|swipe|tap`。`Installer.launch()` 的热路径不走它：`grantRuntimePermissions`、`resolveLauncher`、`pidof`、`am start`、失败时的 `logcat` 各自 `execFile` 一次 adb。
- `staysAlive()` 在 25 秒内每秒 `pidof` 一次。大应用首启的等待会被进程创建放大。
- 滚轮和存活查询如果共用一条 shell，滑动会排在 `pm grant` 后面。必须分两条连接。

实施方案：

1. 把 `_inputSession` 的排队、分帧、超时抽成 `src/core/shell-session.js`。输入通道继续只接受 `isInputCommand`。
2. 新增 `AdbClient.query(cmd)`，第二条会话，白名单只含：
   - `pidof <包名>`
   - `pm path <包名>`
   - `cmd package resolve-activity --brief <包名>`
   - `pm grant <包名> <权限>`
   - `am force-stop <包名>`
   - `input keyevent <数字>`（返回键兜底，见第 4 节）
3. 多行输出一直攒到标记行再 resolve。标记行的判定保持「整行相等」，不要改成包含。
4. `Installer.launch()` 和 `AdbClient.waitAppAlive()` 改走 `query()`。`am start` 与 `logcat` 仍走一次性 `exec`：前者参数组合多，后者输出大，放进常驻 shell 容易把标记行冲掉。
5. 单测喂假的 stdout 分片，覆盖：命令回显、标记被拆进两个 chunk、超时后会话被丢掉。不需要设备。

验收：同一次启动里，`pidof` 不再对应新的 `adb.exe` 进程；输入通道的等待队列在查询进行时长度不变。

风险：设备 offline 时两条会话会一起死。现有 `input()` 的做法是失败即 `disposeInput()`，查询会话同样处理，下一次调用再拉起。不要在查询会话里做交互式 `pm` 确认。

## 4. 返回和滚轮走模拟器控制台

判定：分步做。左键保持交给 Qt。不引入 gRPC，也不新增 npm 依赖。

依据：

- 左键是嵌入窗口里 Qt 的原生手指映射，坐标和按下/抬起由模拟器自己完成。再注入一遍会产生双击。
- 右键和滚轮已经在 `agent.ps1` 里被吃掉，再经 `WinAgent` 事件到 `runtime.client().input()`。慢的一段是 guest 里的 `/system/bin/input`，不是钩子本身。
- 官方 Emulator 的控制台就在当前 console 端口（偶数，`EmulatorEngine.port`）。协议是 TCP 文本：先 `auth <token>`，再 `event key` / `event mouse`。token 文件随 Emulator 家目录走。本项目把 `ANDROID_EMULATOR_HOME` 指到 AVD 家目录，同时也要看 `%USERPROFILE%\.android\emulator_console_auth_token`。
- gRPC（`-grpc`）要 protobuf 或 HTTP/2 客户端，和「壳层不引入运行时依赖」冲突，这一阶段不采用。
- 控制台注入的坐标系是 LCD 像素。`pointer.wheelToSwipe()` 已经输出 LCD 上的起止点，可以复用。

实施方案：

1. 新增 `src/core/emu-console.js`：按当前端口连接，读 token，认证，串行发送命令。认证或连接失败时返回明确错误，调用方回退 `AdbClient.input()`。
2. 右键发送 BACK 的按下与抬起。滚轮把现有 swipe 变成一次 `event mouse` 的按下、移动、抬起。仍由 `WheelRouter` 合并刻度，避免一格一次事件。
3. 钩子的安装条件不变：窗口在前台且对应开关打开。控制台只替换注入传输。
4. `agent.ps1` 不改消息过滤。CI 里的 `test/pointer-hook-logic.ps1` 继续负责「哪些消息被吃掉」。控制台客户端用假 socket 测认证和失败回退。

验收：关掉控制台端口时，右键和滚轮行为与现在一致。打开时，任务管理器里不再为每次滚轮出现新的 `adb.exe`（输入通道本来就复用，这里观察的是 guest 侧 `input` 是否还被调用；可以在回退计数日志里确认走了控制台）。

风险：不同 Emulator 小版本的 `event` 子命令有差异。第一版只实现一套命令，探测 `help` 输出失败就永久回退到 adb，直到进程重启。不要在启动参数里加 `-grpc` 或改 GPU/快照参数，避免牵动开机重试矩阵。

## 5. 安装后补存 quickboot

判定：可落地。保存命令已经存在，缺的是调用时机。

依据：

- `EmulatorEngine.buildArgs()` 只有 `hasSnapshot()` 为真才传 `-snapshot apkstart`，否则 `-no-snapshot`。没有快照时误传 `-snapshot` 会让进程一直等下去。
- `installer.finishInstall()` 在安装尝试之前就 `invalidateSnapshot()`。安装失败时快照也已经没了。
- `saveSnapshotSoon()` 和 `stop()` 会执行 `adb emu avd snapshot save apkstart`。前者只在 `bootEmulator()` 成功后约 6 秒调用。后者只在 `this.proc` 还在时由 `emulator.stop()` 调用。
- `Runtime.stop()` 对 `adoptExisting()` 接管来的进程没有本地 `proc`，直接 `emu kill`，不保存。空闲看门狗关的经常是这种进程。
- `snapshot.key` 只在镜像、数据分区大小、引擎版本、分辨率变化时作废快照，并可能 `-wipe-data`。安装应用不会改变这枚指纹，所以「装完应用后的快照」和指纹机制不冲突。
- `saveSnapshotSoon()` 的注释写「模拟器活不过 ApkStart」。`spawnOnce()` 已经 `detached: true`，这段注释是过时的，实现时一并改掉，避免后续把 detached 改回去。

正确性约束：正在运行的客户机磁盘上已经有新应用。不能在新快照写完之前，用旧快照做下一次冷启动。今天的做法是立刻删目录，所以下一次冷启动一定是 `-no-snapshot`。优化只缩短「删掉之后、下一次关机之前」这段窗口，不改变「没有新快照就冷启动」的规则。

实施方案：

1. 把 `invalidateSnapshot()` 移到安装成功、`store.upsertApp` 之后。安装抛错时保留原快照。
2. 抽出 `saveSnapshot(adbPath)`，供三处调用：容器进入空闲（`endApp` 且没有前台应用）、接管路径的 `Runtime.stop()` 在 `emu kill` 之前、现有的 `emulator.stop()`。
3. 保存进行中若再次安装，取消或等本次结束再存一次。保存超时保持今天的 60 秒量级，失败就留着「目录已空」，下次冷启动。
4. 用户正在使用应用时不保存。快照含 2–3GB 的 `ram.bin`，和前台抢磁盘会把刚打开的应用打卡。
5. `test/auto-test.js` 已覆盖「无快照则 `-no-snapshot`」。补一个纯函数或小的状态用例：安装未成功时不调用 invalidate；安装成功后的下一次 `buildArgs` 在目录为空时仍是 `-no-snapshot`。

风险：保存和 `killOrphanProcesses` 重叠会写出半截快照。保存开始前再查一次 `hasSnapshot` 的目标目录是否可写，失败则删除半截目录并走 `-no-snapshot`。不要把 GPU 模式写进 `snapshot.key`，重试矩阵会因此 `-wipe-data`。

## 6. 共享目录

判定：拆开看。shell 路径加固可落地。本机目录事件可落地。客机到本机仍要轮询。把目录做成挂载暂缓。

依据：

- `Sharer.sync()` 对本机文件执行 `adb shell mkdir -p "$(dirname '${remote}')"`。`remote` 来自共享目录下的相对路径，也来自客机列目录的结果。包名有 `SAFE_PKG`，这条路径没有。客机里的应用只要能在 `/sdcard/ApkStartShared` 下放一个带单引号的文件名，这行 shell 就会超出建目录的本意。`adb push` / `adb pull` 走参数数组，不经过这层 shell。
- 同步按 mtime±1500ms 和 size 判断，不传播删除。列表命令失败时若把「空列表」当成「对方全删了」，会把另一侧清空。当前实现没有删除，所以还没有这个坑，加上删除时必须先避开。
- 本机侧 Node 的 `fs.watch(dir, { recursive: true })` 在 Windows 上可用，项目只支持 win32。
- 客机镜像里没有可靠的 inotify 工具。客机到本机继续用现有的 `listRemoteStat`。
- 无 root、系统镜像带 verity。把宿主目录挂进客机要改分区或依赖特定 Emulator 版本的 virtio-fs，和 quickboot 指纹绑在一起，这一阶段不改启动参数。

实施方案：

1. 在 `sharer.js` 增加路径约束：拒绝空串、`..`、绝对路径、NUL 和换行。单引号按 POSIX `'\''` 转义后再放进 `mkdir`。`ensureDirs()` 已经创建根目录，子目录创建失败就跳过该文件并记入 `errors`。
2. 为转义写单元测试，覆盖带引号、空格和 `..` 的相对路径。测试不访问 adb。
3. 下一改动再加本机 `fs.watch`：事件到了就对变化的相对路径做一次 push，8 秒轮询留作客机到本机的方向，并作为 watch 漏事件的兜底。
4. 删除单独做。只有当一侧的列目录完整成功、路径在 `shared-state.json` 里、且另一侧确认不存在时，才删除已同步副本。列目录抛错则本轮不删除任何文件。

风险：watch 在大量小文件时会抖动。沿用 `_busy` 标志，进行中的同步把新事件并成下一轮。单文件 512MB 上限保持不变。

## 7. 安卓多用户隔离

判定：暂缓。

依据：

- 产品模型是一个快捷方式、一个 `AppWindow`、打开时 `force-stop` 其他用户应用。多用户不提供第二个窗口。
- 数据隔离要用 `pm create-user`、`adb install --user`、`am start --user`。Google Play 镜像上的次用户经常没有完整 GMS，工作资料还需要设备所有者应用。
- 外部存储按用户分开之后，`Sharer` 的固定路径 `/sdcard/ApkStartShared` 会指到另一个用户的存储。快捷方式参数、通知点击、权限授予都要带 userId。
- 真要同时看两个应用，改动点是 `AppWindow` 从单例变成按包名索引，并停止在 `beginApp` 里 force-stop。那是另一项产品改动，比多用户更贴近现有窗口代码，但也超出「让运行时更轻」的范围，不放进这一轮。

若以后要做隔离试验，验收标准先写死：在 API 34 Play 镜像上创建次用户、把同一个 APK 装进该用户、用 `--user` 启动、主用户的应用数据目录不可读。这四步有一步失败就停，不改 `.lnk` 参数格式。

## 8. 可以直接做的加固

### 日志滚动

`appLog()` 和 `emulator.js` 的 `emulator.log` 都是 `appendFileSync`，没有大小上限。抽一个 `appendCapped(file, text, maxBytes)`：超过 2MB 就把当前文件换成 `.1`，只留一份旧日志。写失败保持今天的空 catch，不影响启动。

### wmic

`EmulatorEngine.killOrphanProcesses()` 先读 `hardware-qemu.ini.lock/pid`，再用 `wmic process ... get processid,commandline`。锁文件是主路径；`wmic` 在新的 Windows 11 上可能不存在，那时只靠锁文件，命令行里带 AVD 名但没写锁的 qemu 会漏掉。

改成一次 PowerShell：`Get-CimInstance Win32_Process` 过滤 `qemu-system-x86_64.exe` 和 `emulator.exe`，输出 `ProcessId` 和 `CommandLine`。解析放在现有函数里。锁文件逻辑不动。可以用一条假的 CIM 文本做解析测试。

### 收窄 kill-server

两处：

- `emulator.start()` 在冷启动前对固定端口 5044 执行 `kill-server`。这里是在拉起一台新机器，清掉 offline 幽灵记录有理由，保留。
- `Runtime.adoptExisting()` 在尝试接管之前无条件 `kill-server`。接管的目的就是复用还活着的模拟器，重启 server 会把本机其他使用 5044 的客户端一起打断。

`AdbClient.devices()` 目前只保留状态里带 `device` 的行，offline 被滤掉了。接管前改解析 `adb devices` 的原始行：存在 offline 才 `kill-server`，否则直接 `connect`。冷启动路径维持现状。

### sandbox

两个 `BrowserWindow` 都是 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。`preload.js` 只使用 `electron` 的 `contextBridge`、`ipcRenderer`、`webUtils`，没有直接用 `fs`。从 API 使用上看，应用壳窗口可以先打开 `sandbox: true`。

管理窗口先不动：拖放路径、隐藏窗口 `executeJavaScript` 解码图标都在主进程，但设置页按钮多，一次打开两个窗口的 sandbox 不容易定位回归。

验收只能在 Windows 上做：打开应用壳、嵌入模拟器、拖动缩放、右键返回、从主窗口拖入 APK。CI 的 Node 测试看不到 HWND。这一项单独合入，不和拆文件放在一起。

## 明确不做的事

这些和可行性无关，做了会破坏现有约束：

- 自研 hypervisor、GPU 转译或 ART。
- 每次启动把 APK 转译成 x86。转译在 Play 镜像的 native bridge 里，发生在安装时。
- 为了挂载共享目录去改 system 分区或关闭 verity。
- 用投屏替换 `SetParent`。无头模式没有 VSYNC，画面是空的。
- 为了拆文件引入前端框架、打包器或 APK 解析库。

## 建议的改动切片

每一片都可以单独评审、单独回滚。

| 切片 | 主要文件 | 测试 |
|---|---|---|
| 共享路径约束 | `src/core/sharer.js`、`test/auto-test.js` 或新建断言 | 纯函数，CI 可覆盖 |
| 日志上限 | `src/main.js`、`src/core/emulator.js` | 写临时文件断言轮转 |
| CIM 枚举 | `src/core/emulator.js` | 解析样例输出 |
| 接管时少重启 adb | `src/core/engine.js`、`src/core/adb.js` | 解析 offline / device 样例 |
| 快照时机 | `src/core/installer.js`、`src/core/emulator.js`、`src/core/engine.js` | 现有 `buildArgs` 断言加「失败不删」 |
| 查询 shell | 新建 `src/core/shell-session.js`，改 `adb.js`、`installer.js` | 假 stdout |
| 控制台注入 | 新建 `src/core/emu-console.js`，改 `main.js` 的注入回调 | 假 socket；Windows 上再看右键和滚轮 |
| 拆会话与 IPC | 新建 `src/session.js`、`src/ipc/*` | 通道名不变；Windows `--smoke` |
| 拆界面脚本 | `src/ui/*.js`、`index.html` | `--smoke` 看布局 |
| QEMU 搬家 | 新建 `src/core/qemu-legacy.js` | `npm test`；确认默认 `boot()` 仍进 `bootEmulator` |
| sandbox | `src/core/appwin.js` 一处 | 仅 Windows 手测嵌入 |

前四片和快照时机不改变默认开机参数，适合先做。控制台注入和 sandbox 依赖真实窗口。拆文件和 QEMU 搬家不夹带行为变化。
