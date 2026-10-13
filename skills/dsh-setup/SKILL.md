# dsh-vsc 安装 · Windows + WSL

**读者**：被要求在这台机器上装好 dsh-vsc、并让它真能用的编码 agent。

**范围**：只覆盖 **Windows 主机 + WSL2 发行版**。mac / Linux 原生未验证，别照搬。

**已验证组合**（2026-10-13 全程实测）：
Windows 11 `26200.9457` · WSL2 Ubuntu 26.04 · VS Code 1.141.0 · dsh-vsc 0.2.6 · dsh 0.1.1-rc.1

---

## 这份 skill 干什么

README 描述了三件事：扩展会在没有 harness 时自己起一个、已有的 harness 会被自动复用、key 不用给扩展。

**这三条在前提成立时都是真的。** 它们不成立时**不会报错**，只会变成"看起来装好了，侧边栏什么都不干"。

所以这份文档不重写 README 的步骤。它只做一件事：**把前提显式化，并给每条前提一条输出可判定的验证命令。**

---

## 第 0 步 —— 先探测，别先动手

```bash
command -v node && node --version
command -v dsh  && dsh --version
curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:3080/
ls ~/.vscode-server/bin/*/bin/code-server 2>/dev/null | head -1
```

期望：前两条输出路径和版本号，第三条输出 `000`（还没有 harness），第四条有输出。

**`node` 那行如果输出 `/mnt/c/...`，停下来。** 那是 Windows 的 node，用它装 dsh 会装到 Windows 侧去，后面全乱。

---

## 前提一：Linux 侧要有自己的 node

WSL 里没装 node 时，`/mnt/c/Program Files/nodejs/` 会通过互操作混进 PATH，看起来"有 node"，其实是 Windows 的。

```bash
V=24.11.1
curl -L --retry 5 -o /tmp/node.tar.xz "https://npmmirror.com/mirrors/node/v$V/node-v$V-linux-x64.tar.xz"
mkdir -p ~/.local/node
tar -xJf /tmp/node.tar.xz -C ~/.local/node --strip-components=1
export PATH="$HOME/.local/node/bin:$PATH"
```

装到 `~/.local` 不需要 sudo。npm 的 prefix 会跟着变成 `~/.local/node`，所以后面 `npm i -g` 也不需要 sudo。

**验证**：`which node` 输出 `/home/<user>/.local/node/bin/node`。

---

## 前提二：dsh 必须是一个**能启动**的版本

**这是最容易踩死的一条。**

`@deepseek-ai/dsh` 的依赖范围是松的（`^0.1.1-rc.1`、`^1.0.16`）。所以 `npm i -g @deepseek-ai/dsh@0.1.1-rc.1` **只钉住了顶层包**，npm 会把子包解析到更新的版本 —— `cordis-plugin-hmr` 从 `1.0.16` 升到 `1.0.19`，而那个版本没有 `registerConfig` 方法，`dsh-app-boot` 调用它就崩：

```
TypeError: hmr.registerConfig is not a function
```

**症状不是"启动失败"，是扩展的 auto-start 超时** —— 界面上只看到侧边栏一直空着。

```bash
npm config set registry https://registry.npmmirror.com
npm i -g @deepseek-ai/dsh@0.1.1-rc.1
```

**验证 —— 这条是判据，必须跑：**

```bash
cd ~ && timeout 20 dsh web --no-open > /tmp/dsh-check.log 2>&1; echo "exit=$?"
```

| 输出 | 含义 |
|---|---|
| `exit=124` | ✅ 好。124 = 被 timeout 杀掉的，说明它活满了 20 秒 |
| `exit=1`，日志里有 `registerConfig is not a function` | ❌ 子包版本错了，用下面的修复 |

**修复（已验证可用）** —— 用发布时间点把整个依赖集合钉在旧版本上：

```bash
pkill -f "dsh web"; sleep 2
npm i -g @deepseek-ai/dsh@0.1.1-rc.1 --before=2026-08-21T10:00:00.000Z
dsh --version          # 应仍是 0.1.1-rc.1
timeout 20 dsh web --no-open > /tmp/dsh-check.log 2>&1; echo "exit=$?"   # 期望 124
```

> ⚠️ **这段绕过什么时候可以删**：跑 `npm view @deepseek-ai/dsh@<版本> dependencies`，
> 如果 `@deepseek-ai/*` 的取值**都不再带 `^`**（锁成了具体版本），说明上游修了，这段删掉。

---

## 前提三：扩展宿主必须找得到 `node` 和 `dsh`

扩展的 `dshVsc.autoStart`（默认开）会去启动 `dsh web`。**它用的是扩展宿主的 PATH，不是你终端的 PATH。**

WSL 里扩展宿主的 PATH = Linux 默认值 + Windows 互操作 PATH。它**不读 `~/.bashrc`**（Ubuntu 的 `.bashrc` 第 6 行有 `case $- in *) return;;`，非交互式直接退出），也**不含 `~/.local/bin` 或 `~/.local/node/bin`**。

**所以往 `.bashrc` 里追加 PATH 是无效的。**

两条路，选一条：

**路线 A —— 手动起 harness（已验证可用）**

```bash
cd ~/projects/你的项目
setsid nohup dsh web --no-open < /dev/null > /tmp/dsh-web.log 2>&1 &
```

扩展会检测到 `http://127.0.0.1:3080` 上有东西，直接复用，不触发 auto-start。
代价：WSL 每次重启后要重起一次。

**路线 B —— 让它能自动起（机制已验证，软链本身未跑过，要 sudo）**

`/usr/local/bin` **确实在**扩展宿主的 PATH 里（实测读 `/proc/<pid>/environ` 确认）。所以：

```bash
sudo ln -sf ~/.local/node/bin/node /usr/local/bin/node
sudo ln -sf ~/.local/node/bin/dsh  /usr/local/bin/dsh
```

**验证 —— 这条直接读扩展宿主自己的环境，骗不了：**

```bash
PID=$(pgrep -f 'type=extensionHost' | head -1)
tr '\0' '\n' < /proc/$PID/environ | grep '^PATH=' | tr ':' '\n' | grep -E '^/usr'
```

期望：看得到 `/usr/local/bin`。（看不到 `~/.local/node/bin` 是正常的 —— 所以才要上面那两条软链。）

**失败时的样子** —— 扩展的 "DSH Bridge" 输出通道里会写：

```
cannot resolve node/dsh for the silent launch — PATH missing `node` or the `dsh` shim
DSH 服务连续 3 次启动失败，本次会话不再自动重试
```

对应文件在：

```
~/.vscode-server/data/logs/<时间戳>/exthost*/output_logging_*/2-DSH Bridge.log
```

**排查优先看它。**

---

## 前提四：key 要配在 harness 那一侧

扩展不碰 key（这点 README 说对了）。key 属于 `~/.dsh/.credentials.yaml`。

没配的症状：**一轮 0 秒就"完成"**，界面上什么都不发生。会话记录里是：

```
MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
```

三种配法：

**① 从另一台已配置好的机器复制（已验证可用）**

```bash
tr -d '\r' < /mnt/c/Users/<你>/.dsh/.credentials.yaml > ~/.dsh/.credentials.yaml
chmod 600 ~/.dsh/.credentials.yaml
```

那个文件是**明文**的（`DEEPSEEK_API_KEY` 就是 `sk-` 开头那串），可以跨机器复制。

**② 侧边栏的设置界面** —— 面板通过 postMessage 交给 WSL 侧的扩展宿主去写，这条路能通。

**③ `export DEEPSEEK_API_KEY=...` 之后再起 harness。**

> ⚠️ **不要用 `DSH: Open Web GUI` 那条命令配 key。** VS Code 的 webview 在**客户端（Windows）**渲染，里面的 `127.0.0.1:3080` 由 Windows 解析 → 打到 Windows 那个 harness 去了。NAT 模式下 WSL 的 3080 从 Windows 永远够不着。

**验证：**

```bash
dsh --profile headless "只回复两个字母: OK"
```

期望：打印 `OK`。打印不出来、或又报 `MISSING_CREDENTIAL`，就是 key 没生效。

---

## 前提五：harness 的 workspace = 你启动它的那个目录

`dsh web` 拿 **cwd** 当 workspace。会话按 **workspace 的绝对路径**分桶，存在 `~/.dsh/sessions/<编码后的路径>/`。

**先 `cd` 到项目目录，再起 harness。**

**验证：**

```bash
ls ~/.dsh/sessions/
```

桶名是路径编码后的样子 —— 斜杠变 `-`，整串用 `--` 包起来，非字母数字转义（空格 → `~0020`）。
例：`/home/whitedew` → `--home-whitedew--`；`D:\Microsoft VS Code` → `--D-Microsoft~0020VS~0020Code--`。

> 换目录 = 换桶 = 看不到那个目录的会话。**历史没丢，只是分桶了。**

---

## 收尾：前提立住之后，回头再判 README

| README 说 | 依赖的前提 |
|---|---|
| 扩展会在没有 harness 时自己起一个 | 前提三（PATH 里有 `node` + `dsh`） |
| 已有的 harness 会被自动复用 | 前提二（那份是**能启动**的版本） |
| key 不用给扩展，配在 DSH 侧 | 前提四 |

**前提没立住时，这三条不是"错"，是"还轮不到它成立"。**
所以别急着改 README —— 先按这份 skill 走通一遍，再逐条对照。

---

## 失败定位表

| 现象 | 大概率是哪条前提 |
|---|---|
| 侧边栏一直空着 | 前提三 → 看 DSH Bridge 日志 |
| 一轮 0 秒完成 | 前提四（key） |
| 侧边栏连不上，但手动 `dsh web` 能起 | 前提三 |
| `dsh web` 一跑就崩 | 前提二（版本） |
| 会话列表空的，但 `~/.dsh/sessions/` 下有别的目录 | 前提五（cwd 不对） |
| 浏览器/Web GUI 打开的是另一个 harness | 你在用 `DSH: Open Web GUI`，改用侧边栏 |
| 扩展列表里没有 dsh-vsc | 还没装：`~/.vscode-server/bin/*/bin/code-server --install-extension <vsix 路径>`，然后 Reload Window |
