# Echo360 Lite 代码质量审查

- 审查对象：`src/`（32 个模块，约 7,900 行）、`build.mjs`、`test/unit.test.mjs`，版本 0.11.1（提交 `48ca63b`）
- 方法：逐个文件通读源码。以下结论都只来自代码本身，没有参考作者的意图或开发记录。
- 本次审查**没有修改任何源码**。我另外运行了 `node build.mjs`，产物和仓库里的 `dist/` 完全一致（构建可复现）；运行了 `node --test test/unit.test.mjs`，27 个测试全部通过（约 19 秒）。
- 每条问题的可信度标注：
  - **已确认**：从代码就能完整推出触发路径。
  - **很可能**：触发路径成立，但依赖浏览器或服务器的具体行为，需要在真实环境里复现一次。

严重程度：🔴 严重（会让页面不可用或丢失用户数据）· 🟠 较高（功能失效或资源泄漏，用户能察觉）· 🟡 中等（边界情况或潜在隐患）· ⚪ 低（整洁度和可读性）

---

## 0. 最值得先处理的 10 个问题

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| E1 | 🔴 | `90-main.js` / `40-player.js` `LitePlayer` 构造函数 | 构造到一半抛异常时，已经建好的播放器界面、定时器和网络任务全部没人清理，残留的界面会盖在原播放器上面 |
| E2 | 🔴 | `40-player.js` `loadClock` + `store.get('prefs')` | 本地设置损坏或备份恢复写进非法值（比如 `rate: "x"`）会让构造函数每次都抛异常，结合 E1，每次打开页面都会坏 |
| S1 | 🟠 | `40-player.js:815` 和 `:1239`，`$('.pclose')` | 两个不同按钮共用 class `pclose`：侧栏的关闭按钮永远没有响应，PDF 栏的 ✕ 一次触发两种行为（**已确认的功能 bug**） |
| C1 | 🟠 | `48-discussion.js` `post`/`submit`，`47-notes.js` `addNote` | 用 Ctrl+Enter 可以重复提交，**公开讨论帖可能发两遍** |
| L1 | 🟠 | `36-session.js` `renew().finally` | 正在续期时退回原播放器，会重新排一个定时器，之后每小时在后台抓一次课程页面，没有尽头 |
| L2 | 🟠 | `58-slide-ocr.js` `recognize` | 停止和创建 Tesseract 引擎之间有竞态，可能留下一个永远不终止的 Worker（含 WASM，体积大） |
| E3 | 🟠 | `00-util.js` `guard` 的整体策略 | 次要功能里的同步异常会把整个播放器换成原播放器；异步异常则悄无声息。两种处理一个过重、一个过轻 |
| E5 | 🟠 | `56-slides.js` `fromKeyframes`、`54-silence.js` `runAudio` | 单个分片失败就中断整条分析，已经分析了的结果也被丢弃 |
| L4 | 🟠 | `59-slide-deck.js` `rendered` 缓存 | 只限制条数（6 张）不限制大小，每张画布最多 4096px 宽，内存可能达到数百 MB |
| T1 | 🟠 | `test/` | 决定接管还是回退的 `adapter.parse`/`intercept`，以及播放器的创建和销毁，完全没有测试；`test/fixtures/` 里的三份人工标注数据没有任何测试使用 |

---

## 1. 错误处理

### E1 🔴 构造失败时半成品播放器无人清理（已确认）
- **位置**：`90-main.js:28` 的 `player = new LitePlayer(...)`；`40-player.js` 的 `LitePlayer.constructor`（28–112 行）
- **问题**：构造函数先执行 `buildDom()`，把宿主元素挂进 `document.body` 并设置 `documentElement.style.overflow = 'hidden'`；随后依次创建 `SessionKeeper`（启动定时器、写入全局 `mediaSession`）、两个 `Stream`，并绑定几十个监听器，最后才调用 `setupSilence/Slides/Deck/loadCues/loadInteractions/setupAudio/loadClock`。这期间任何一步抛异常，`new` 表达式就失败，`player` 仍然是 `null`。`main` 的 `catch` 随后调用 `startOriginal`，其中的 `if (player) player.destroy()` 不会执行，`this.d`（Disposer）也就永远不会被 dispose。
- **会抛异常的实际路径**：
  - `Stream.load()` 在既没有 MSE 也没有原生 HLS 时**主动 throw**（`35-stream.js`）。比如 `@require` 的 hls.js 被拦截，导致 `HlsLib` 为 `undefined`，而浏览器又不支持原生 HLS（桌面 Chrome/Firefox）。这一步恰好是构造函数的最后一步，前面的东西已经全部建好了。
  - 设置值非法（见 E2）。
  - `attachShadow`、`ResizeObserver`、`OffscreenCanvas` 等 API 在个别环境下不存在。
- **后果**：一个全屏、黑色、没有视频的播放器界面盖在原播放器上面，页面滚动被锁死；同时还有后台定时器（续期、停滞检测、设置保存）和已经发出的网络请求（会话校验、转写、笔记）。用户看到的是"脚本把页面弄坏了"，正好和 README 承诺的"出错时自动回退"相反。
- **修复建议**：
  1. 构造过程整体用 try/catch 包起来，失败时先 `this.d.dispose()` 再重新抛出：
     ```js
     constructor(lesson, opts) {
       this.d = new Disposer();
       try { this.init(lesson, opts); } catch (e) { this.destroyed = true; this.d.dispose(); throw e; }
     }
     ```
  2. 或者把"能失败的检查"（是否有播放能力、设置是否合法）提到 `buildDom()` 之前完成。
  3. `Stream.load` 的能力检测可以挪到 `adapter.parse` 之后、创建播放器之前。

### E2 🔴 设置损坏会让播放器"每次都坏"（已确认）
- **位置**：`40-player.js` 构造函数的 `Object.assign(defaults, store.get('prefs', {}))`；`loadClock()` 第 207 行的 `v.defaultPlaybackRate = this.prefs.rate`；`85-export.js` 的 `restoreBackup()`
- **问题**：构造函数只校验了 `layout/corner/capSize/silence/quality` 这几项。`rate、volume、ratio、pipw、panelw、audio、copySpan` 都原样使用。`HTMLMediaElement.playbackRate/defaultPlaybackRate/volume` 收到非有限值（NaN）时会抛 `TypeError`。`restoreBackup()` 会把备份文件里 `local` 的任意字符串原样写回 localStorage，没有做结构校验。
- **后果**：一次错误的恢复（或者以后版本改了设置格式）会让 `prefs.rate` 变成非数字。从此每次打开课程页都会在 `loadClock` 抛异常，进入 E1 的状态。用户只能手动清 localStorage 才能恢复，而用户并不知道这个办法。
- **修复建议**：写一个集中的 `sanitizePrefs(raw)`，每个字段都检查类型和范围，非法就回到默认值；`restoreBackup` 也走同一个校验（或者只接受已知的键）。在构造函数里加一个兜底：`store.get('prefs')` 解析失败或校验失败时，丢弃整份设置。

### E3 🟠 `guard()` 的影响范围：一刀切回退，加上异步异常被静默吞掉
- **位置**：`00-util.js` 的 `guard/reportUnexpected`；`90-main.js` 的 `unexpected.handler`；`46-sidebar.js` 的 `h()`，所有 `on*` 回调都经过 `guard`
- **问题**：
  1. **太重**：所有经 `Disposer.listen/interval/timeout`、`h({onclick})` 注册的同步回调，只要抛异常，整个播放器就被销毁并换成原播放器。这包括标签管理、导出面板、A-B 循环、缩放、PDF 阅读器、静音菜单这类可有可无的功能。一个标签颜色按钮的 bug 就能让正在看课的用户被踢回原播放器，播放位置能保留，但侧栏、笔记草稿、PDF 视图都没了。
  2. **太轻**：`guard` 只能捕获同步异常。项目里大量回调是 `async` 函数或者返回 Promise，比如 `h('button', { onclick: (e) => this.addNote(e) })`、`onKey` 里调用的 `this.notes.tagHere(e)` 和 `this.togglePopout()`，还有 `loadCues/loadInteractions` 里的 `.then(...)`（没有 `.catch`）。这些地方抛出的异常会变成 unhandled rejection，功能停在半完成状态，没有任何提示。
- **后果**：同一类 bug，出现在同步代码里就整体回退，出现在异步代码里就静默损坏，行为取决于偶然的代码写法。
- **修复建议**：分两级处理。
  - **核心播放**（Stream、时钟视频事件、布局）出错才回退到原播放器。
  - **功能模块**用 `featureGuard(name, fn)` 包裹，出错时只关闭这个功能，在控制台记录并提示一次。
  - 增加 `guardAsync(fn)`，它返回 `fn(...).catch(report)`，统一用在所有 async 回调上。
  - 可以在 `main` 里注册一个仅用于记录日志的 `unhandledrejection` 监听，方便发现漏掉的地方。

### E4 🟠 后台分析的 `onChange` 在分析自己的 Promise 链里同步执行，UI 异常会被误报为分析失败
- **位置**：`54-silence.js` 的 `SilenceAnalyzer.start/runAudio/fail`；`56-slides.js` 的 `SlideAnalyzer.start/run`；`58-slide-ocr.js` 的 `SlideTextReader.run`；`59-slide-deck.js` 的 `readingChanged → decide → onChange`
- **问题**：分析器在循环中途调用 `this.onChange()`，这个回调又调用播放器的渲染函数（`renderSilences`、`onSlidesChange`、`applyLayout`、`reader.update` 等）。渲染函数一旦抛异常，就会被分析器的 `.catch` 当作"分析失败"处理：静音分析变成 `fail('error')` 并清空结果，章节检测变成 `unavailable`，OCR 变成 `unavailable`。`SilenceAnalyzer.fail()` 在 catch 里又调用一次 `onChange()`，如果再抛异常就成了 unhandled rejection。
- **后果**：一个界面渲染 bug 会让用户以为"这节课没检测到静音或章节"，控制台里的报错也指向错误的模块，排查方向被带偏。
- **修复建议**：分析器内部统一用 `emit()` 调用回调：`try { this.onChange(); } catch (e) { console.error(TAG, 'onChange', e); }`。或者用 `queueMicrotask`/`FrameTask` 把通知改成异步，和计算逻辑隔开。

### E5 🟠 单个分片出错就中断整条分析，已经算出的部分也丢掉（已确认）
- **位置**：
  - `56-slides.js` 的 `fromKeyframes`：循环里的 `reader.keyframe(i)` 没有逐个 try/catch。分片不以关键帧开头、单个分片返回 404、解码失败，都会中断整个流程。
  - `56-slides.js` 的 `fromThumbnailsAsync`：一张缩略图失败就放弃全部缩略图章节。
  - `54-silence.js` 的 `runAudio`：一个音频块 `decodeAudioData` 失败就 `fail('error')`，`silences = []`。但已经填好的包络数据还在内存里，最近一次 `save` 也已经写进缓存，只是不再使用。
- **对比**：`58-slide-ocr.js` 做了逐样本容错（`OCR_FAILED`），说明作者知道这个问题，但只在一个模块里处理了。
- **修复建议**：逐个分片 try/catch，失败时记一次并跳过，连续失败超过 N 次再放弃。静音分析出错时保留已有结果，可以用 `recompute()` 代替 `fail()`。

### E6 🟡 OCR 的失败样本被永久缓存，以后再也不会重试
- **位置**：`58-slide-ocr.js:176` 的 `this.at[i] = OCR_FAILED`；`next()` 只挑 `=== -1` 的样本；`save()` 把结果写进 IndexedDB
- **后果**：一次临时的网络抖动或者 403 就会让这个 10 秒片段永远没有文字，跨页面访问也一样。PDF 跟读在这段只能靠前后推断。
- **修复建议**：缓存时把 `OCR_FAILED` 写回 `-1`；或者记录失败次数，下次访问再重试一次。

### E7 🟡 IndexedDB 封装吞掉所有错误，而且打开失败的 Promise 会被一直缓存
- **位置**：`53-media-io.js` 的 `idbCache.open/get/put/del/keys`
- **问题**：
  1. `put` 失败（比如加入大 PDF 时超出配额）resolve 为 `undefined`。`addFiles` 里的 `await idbCache.put('deckfile:'+hash, …)` 看起来成功了，`files` 里也记下了这个文件，但下次 `reload()` 时 `get` 返回空，代码 `continue` 跳过，PDF 就无声地消失了。
  2. `open()` 把被 reject 的 Promise 存进 `this.db`，之后的调用一直返回这个失败的 Promise，整个页面生命周期里 IndexedDB 都不可用，不会重试。
  3. 没有处理 `onblocked` 和 `onversionchange`：以后数据库版本升级时，另一个标签页里打开的旧连接会阻塞升级。
- **修复建议**：`put` 至少要 `console.warn`；关键写入（PDF、恢复备份）要用会抛错的版本，并把失败提示给用户。`open` 失败时清空 `this.db`。补上 `db.onversionchange = () => db.close()`。

### E8 🟡 `togglePopout` 在中途抛异常会让播放器从页面上消失
- **位置**：`40-player.js:666–711`
- **问题**：`this.host.replaceWith(holder)` 已经把播放器从主页面摘下来，之后才 `doc.body.append(this.host)` 和注册 `pagehide`。中间任何一步抛异常（`requestWindow` 已经成功），宿主元素就不在任何文档里了，`pagehide` 也还没注册。由于这是 async 函数，异常不会经过 guard，回退也不会触发。
- **后果**：主页面只剩"已在浮窗中播放"的占位框，点"返回"会关闭浮窗，但没有 pagehide 处理函数把播放器放回来。
- **修复建议**：先注册 `pagehide`，再移动元素；或者用 try/catch 包住移动过程，失败时 `holder.replaceWith(this.host)` 并关闭浮窗。

### E9 ⚪ 其他错误处理细节
- `20-reporter.js`：所有上报请求 `.catch(() => {})` 时没有任何记录。上报关系到出勤和观看统计，建议至少在 debug 模式下 `console.debug`。
- `90-main.js` 的 `startOriginal`：`callOriginal` 或 `cpuFix.start` 抛出的异常会穿过 `launcher` 进入页面自己的启动代码，结果难以预料，建议包一层 try/catch。
- `90-main.js` 的 8 秒兜底定时器：`booted` 为 false 时只会提示"无法接管"。如果页面在 8 秒后才调用启动函数，用户会先看到"已回退"的提示，然后精简播放器又启动了，提示是错的。
- `85-export.js` 的 `restoreBackup`：逐条写入，中途失败会留下一半新、一半旧的数据，而且返回的计数不包含失败的条目。

---

## 2. 资源和生命周期

> 说明：代码里**没有在同一页面内"切换录像"的路径**。每个录像都是一次完整的页面加载，`LitePlayer` 只创建一次，`courseList` 和播放器也互斥。所以生命周期问题集中在两类场景：(a) 退回原播放器时 `destroy()` 的清理是否完整；(b) 页面内部的"重新加载"，比如单画面布局切换视图时重载时钟流、增删 PDF 时重建文档和 OCR。

整体评价：`Disposer` 加上 `AbortController` 加上 `BackgroundGate` 的设计是对的，绝大多数监听器、定时器、Observer 都由它管理。下面列出的是这个机制的漏洞。

### L1 🟠 `SessionKeeper` 在 dispose 之后还会给自己重新排定时器（已确认）
- **位置**：`36-session.js` 构造函数里的 `this.d.add(() => clearTimeout(this.timer))`；`renew()` 第 74 行的 `.finally(() => { …; if (!this.failed) this.schedule(); })`；`attempt()` 里重试用的 `setTimeout`
- **问题**：dispose 只清掉当时那个定时器。如果 dispose 时正有一次续期在进行（fetch 中，或者在 2 秒/5 秒的重试等待里），它结束后 `finally` 会调用 `schedule()` 创建新的定时器，而这个定时器已经没人管了。它触发后又 `renew()`，再 `schedule()`……整个页面生命周期里每小时抓一次课程页面。
- **后果**：退回原播放器后，后台仍然在定时请求 Echo360，和原播放器自己的续期叠在一起。这个泄漏无法通过 UI 停止。
- **修复建议**：增加 `this.disposed` 标志，`d.add(() => { this.disposed = true; clearTimeout(this.timer); })`；`schedule()` 和 `attempt()` 开头检查这个标志；重试等待改用 `BackgroundGate.wait` 这类可以被中止的等待。

### L2 🟠 OCR 引擎在停止之后仍可能被创建出来（很可能）
- **位置**：`58-slide-ocr.js` 的 `stop()` 和 `recognize()`（219 行起）
- **问题**：`stop()` 执行 `ac.abort()`，并在 `this.engine` 存在时 terminate，然后把它设为 `null`。可是 `run()` 循环可能正停在 `await canvas.convertToBlob(...)` 上。它恢复执行后直接调用 `recognize(blob)`，看到 `this.engine === null` 就**新建**一个 Tesseract Worker，然后才检查 `aborted` 并抛出。这个新 Worker 没人 terminate。
- **触发场景**：OCR 正在读取时，用户移除最后一个 PDF（`reload()` → `ocr.stop()`）或者退回原播放器。
- **后果**：残留一个加载了 WASM 和英文语言包的 Worker（几十 MB），一直存活到页面关闭。
- **修复建议**：`recognize()` 开头先检查 `this.ac.signal.aborted`；`stop()` 设置 `this.stopped = true`，之后不再创建引擎。也可以在 `engine.then` 里判断，如果已经停止就立即 terminate。

### L3 🟠 pdf.js 的 Worker 是模块级单例，永远不终止
- **位置**：`59-slide-deck.js:32` 的 `loadPdfJs()`，其中 `lib.GlobalWorkerOptions.workerPort = new Worker(...)`
- **问题**：这个 Worker 挂在模块级的 `pdfjsPromise` 上，`SlideDeckController` 的 dispose 只会 `closeDocs()`。退回原播放器或删除所有 PDF 之后，它依然存在。
- **修复建议**：把 Worker 的所有权交给 `SlideDeckController`，dispose 时 `terminate()`；或者在 `closeDocs()` 时文档数量为 0 就终止它。

### L4 🟠 渲染缓存只按条数限制，内存可能很大
- **位置**：`59-slide-deck.js:29` 的 `DECK_RENDER_CACHE = 6`、`render()`；`57-slides-pane.js` 的 `drawInto()`（宽度最多 `4096 * dpr * sharp`，最终上限 4096）
- **问题**：缓存键是 `index@width`。窗口缩放、拖动分隔条、缩放倍数变化（`sharp` 最高 4）都会生成新的键。一张 4096×2304 的画布约 37 MB，6 张就超过 200 MB。淘汰方式是先进先出，不是 LRU。`drawInto` 每次绘制还会额外创建一张同样大小的画布，叠在页面上做淡入效果。
- **修复建议**：按像素总数设预算（比如 40 Mpx）；只保留每页最新宽度的那一份；改成真正的 LRU（命中时先 delete 再 set）。

### L5 🟡 退回原播放器时浮窗（Document PiP）的 `pagehide` 可能把已销毁的界面放回页面（很可能，需要验证）
- **位置**：`40-player.js` 的 `togglePopout` 里的 `pagehide` 处理函数；`bindControls` 里的 `d.add(() => { if (this.popout) this.popout.close(); })`
- **问题**：Disposer 按注册的逆序执行，所以先 `popout.close()`，后 `host.remove()`。如果浮窗的 `pagehide` 是**异步**触发的，它会在 `host.remove()` 之后执行，`holder.replaceWith(this.host)` 会把已经销毁的播放器界面重新插回主页面，盖在原播放器上面。如果是同步触发则没有问题。
- **修复建议**：在 `pagehide` 处理函数开头判断 `if (this.destroyed) { holder.remove(); return; }`；dispose 时主动移除 `holder`。

### L6 🟡 只增不减的监听器和引用
- `57-slides-pane.js` 的 `SlideReader.onInfo()`：只能添加，没有移除接口。`SlidesPane.dispose` 没有注销自己的监听。
- `59-slide-deck.js` 的 `startReading()`：每次新建 `SlideTextReader` 都会往**播放器的** Disposer 里加一个闭包（`opts.disposer.add(() => this.stop())`）。用户反复删除、添加 PDF，旧的 reader 连同它的 `texts` 和 `at` 数组会一直被引用，直到页面关闭。建议给每个 reader 一个 `d.child()`，停止时就 dispose 它。
- `56-slides.js` 的 `thumbUrl()`：`urlOf: Map<Blob, url>` 和 `urls` 数组只增不减。`applyScenes` 每 30 个分片调用一次，章节变化后不再使用的缩略图 Blob 仍被这个 Map 引用，直到 dispose 才释放。
- `35-stream.js` 的 `MEDIA_ATTACHED` 处理函数里，`v.addEventListener('loadedmetadata', …, {once:true})` 不受 Disposer 管理。如果在这个监听触发之前切换了视图（hls 实例被销毁、换了新源），它会在新源加载时执行，把位置跳回旧的 `r.t` 并强行播放。
- 未纳入 Disposer 的零散定时器：`ABLoop.timer`、`Zoomer` 的 `setTimeout(() => dragged=false)`、`drawInto` 的淡出定时器、笔记和讨论删除按钮的 3 秒倒计时、`renderReplyComposer` 的 focus 定时器、`TranscriptPanel.searchTimer`（这个有清理）。单个影响很小，但 `ABLoop.timer` 被 guard 包裹，在播放器销毁后触发仍会访问 `this.p`。

### L7 🟡 IndexedDB 只写不删，存储会持续增长
- **位置**：`slides:<mediaId>`（含 JPEG 缩略图 Blob）、`ocr:<mediaId>:<idx>`、`silence-env:<mediaId>`（2 小时录像约 72 KB）、`watched:`、`deckfile:`
- **问题**：没有过期和淘汰机制。一个学期十几门课、几百个录像，仅章节缩略图就可能达到数百 MB。缓存版本号都写死为 `v: 1`，和算法参数没有关联（见 H5）。
- **修复建议**：每条记录带上 `at` 字段（部分已有），启动时异步清理 N 天未访问的分析缓存；提供"清除分析缓存"按钮。

### L8 ⚪ 不需要清理但值得注明的长期资源
- `80-course-list.js`：`MutationObserver` 观察整个 `document.body` 的子树，从不断开。课程页本身是长期页面，这样做可以接受。但如果站点是 SPA，在页面内跳到另一门课，闭包里的 `section` 是旧值，`known` 也不会清空。
- `60-cpufix.js`：永久修改 styled-components 的原型，并在 `window` 上注册捕获阶段的 `timeupdate` 监听，这是设计使然。
- `20-reporter.js` 注册了 `beforeunload` 监听，在部分浏览器（Firefox）里会让页面无法进入 bfcache。用 `pagehide` 就够了。
- `90-main.js`：开启 debug 时，`window.__echo360LitePlayer` 在播放器销毁后仍然引用它。

---

## 3. 写死的数值

下面这些常数大多附有"在一节真实课程上测得"或"离线调好"之类的注释。也就是说，它们是**针对少数样本拟合出来的**，没有回归数据保护，换一个学校、一门课或一个录制配置就可能失效。

### H1 🟠 默认"HLS 分片 = 10 秒"散落在多处
- `54-silence.js` 的 `CHUNK_SEGMENTS = 6`（注释"6 x 10 s HLS segments"），`chunkAt()` 还假设所有分片等长
- `56-slides.js` 的 `applyScenes` 用 `samples[last].t + 10`；整套章节分辨率（"10 s resolution"）和精确定位都建立在一个分片约 10 秒上
- `59-slide-deck.js` 的 `followSamples`（`times[n-1] + 10`）、`timesOf`、`partAt`（`times[b] + 10`）
- `58-slide-ocr.js`：每个分片识别一次，所以分片越短，OCR 工作量越大（2 秒分片会多 5 倍）
- **后果**：其他部署如果用 2/4/6 秒分片，静音分析每块只有 12–36 秒、请求数暴增，章节和 OCR 的成本成倍增加，末尾时间的估计也会偏。
- **建议**：从播放列表读出实际的 `#EXT-X-TARGETDURATION` 或平均分片时长，用"秒"来定义块大小（比如每块 60 秒），不要用"分片个数"。

### H2 🟠 画面比较阈值（章节检测）
- `56-slides.js` 的 `sameView`：`changed < 0.16 || mad <= 8 || (corr >= 0.9 && mad <= 20)`，注释写的是 "Measured on a real lecture"
- `sameViewStrict`：`0.06 / 6`；`frameDistance` 里的像素变化阈值 `> 40`
- `flatShare`：相邻像素亮度差 `<= 3`（在 160×90 下）；`SCREEN_CLEARLY = 0.75`；"6 张缩略图里至少 3 张可读"
- `SCENE_MIN_SEC = 20`、`SCENE_REVISIT_SEC = 180`、`SCENE_DETOUR_SEC = 60`
- `KEYFRAME_PROBE_BYTES = 24 KB`（按 360p 关键帧约 17 KB 估算）；`smallBitmap` 写死 16:9
- **风险**：深色主题幻灯片、手写板或平板投屏（大量墨迹）、带视频的幻灯片、4:3 屏幕、摄像头对着白板（"平坦度"高，可能被误判为屏幕画面）。
- **建议**：把这组参数集中到一个 `SLIDE_TUNING` 对象里，并在旁边注明它是用哪几节课调出来的。最重要的是把 `test/fixtures` 里的标注数据接入测试（见 T2），这样以后改阈值时能看到准确率的变化。

### H3 🟠 OCR 和文字匹配只适用于英文和拉丁字母
- `58-slide-ocr.js`：Tesseract 只加载 `eng` 语言包，写死 `OCR_HEIGHT = 720`、`OCR_PIXEL_DIFF = 24`、`OCR_SAME_MAX = 12`（注释说按 720p 下"最小可读字号"估算）
- `58-slide-text.js` 的 `slideWords`：`/[a-z][a-z0-9]{2,}/g`。中文、日文、希腊字母、带重音的字母、两个字母的缩写（"AI""ML"）全部被丢掉。停用词表也是英文。
- `SLIDE_MOVES` 里的转移概率（0.45/0.30/0.05/0.04/0.01/0.15……）、`EVIDENCE_GRID = 101`、`-25` 截断、200 次 EM 迭代、标准差下限 0.01，都是手工设定的。
- **后果**：中文课程、数学公式多的课程、用小字号或 1080p 高 DPI 投屏的课程，PDF 跟读几乎一定失败，而且没有提示原因（只会显示"无法识别页面"）。
- **建议**：分词改用 Unicode 属性（`\p{L}[\p{L}\p{N}]+`，CJK 按字或二元组切分）；语言包根据 PDF 文本检测结果选择；转移概率可以从用户的手动纠正数据里统计。

### H4 🟡 音频处理参数
- `52-audio.js`：压缩器阈值 -34 dB、压缩比 3.5:1，增强频段 3 kHz +4 dB，高通 100 Hz，目标 -20 dBFS，最大增益 18 dB，每步 +0.75/-1.5 dB，静音判定 `1e-8`，EMA 系数 0.85。注释写的是"Tuned offline on real lecture audio"。
- `54-silence.js`：语音频段 150 Hz–4 kHz（一阶滤波器**每块重置状态**，每 60 秒的块边界会出现瞬态）；噪声和语音分别取第 10、第 90 百分位；灵敏度系数 0.2/0.3/0.4；判断动态范围的 `speech - noise < 6` 和 `speech < -55`；开始前等 8 秒；`gate.turn(2000, 400)`。
- **建议**：滤波器状态跨块延续，或者每块前后多取约 0.5 秒重叠；阈值集中定义并写明调参所用的样本。

### H5 🟡 缓存版本号和算法参数脱钩
- `slides:`、`silence-env:`、`ocr:` 的记录都写死 `v: 1`。改了 H2–H4 的任何阈值，老用户看到的仍然是旧算法的结果，而且是永久的。
- **建议**：用 `ALGO_VERSION`（或者对相关常数做哈希）作为版本号，不一致就重新计算。

### H6 🟡 交互和网络参数
- `40-player.js`：停滞看门狗"12 秒不动就踢一下"（每 2 秒检查一次）；断点续播要求 `> 1` 秒且 `< 时长 - 10` 秒；续期后 30 秒内再被拒就判定失败；控件 2500 ms 后自动隐藏；单击 200 ms 后才判定为非双击；进度条标记吸附 6 px；拖动时每 200 ms 跳转一次；每 10 秒保存一次位置。
- `35-stream.js`：`abrEwmaDefaultEstimate: 5e6`（假设一开始就有 5 Mbps），`abrBandWidthFactor` 设为 0.95/0.85（摄像头 0.7/0.6），`maxBufferLength 30`，`backBufferLength 60`，网络重试 4 次，媒体错误恢复 2 次。在宿舍或手机热点这类慢网络下，"起步就选最高清晰度"会让首帧明显变慢。
- `36-session.js`：重试间隔 `[2000, 5000]`，默认续期 1 小时，最短间隔 60 秒。
- `80-course-list.js`：并发 2 个、间隔 150 ms、≥95% 算看完、300 ms 防抖。
- `59-slide-deck.js`：`FOLLOW_MIN_SEC 15`、`FOLLOW_STALE_SEC 120`、`FOLLOW_UPDATE_MS 15000`；`pageTitle` 取页面上部 40%、字号差 `< 1`；`ar || 0.5625`。
- `10-adapter-echo360.js`：没有 `endMs` 的字幕默认持续 3000 ms。
- `90-main.js`：8000 ms 的启动兜底。
- 这些多数是合理的产品参数，问题在于散落在各个函数里。**建议**集中到一个 `CONFIG` 区，注明单位和来源。

---

## 4. 模块结构

### S1 🟠 选择器冲突：两个按钮都叫 `.pclose`（已确认的功能 bug）
- **位置**：`30-ui-assets.js:440`（PDF 栏的 ✕，`pnav pclose`）和 `:542`（侧栏关闭按钮，`btn pclose`）；`40-player.js:815` 的 `d.listen($('.pclose'), 'click', () => this.sidebar.close())`；`:1239` 的 `bar('.pclose', () => this.setPdfMain(false))`
- **问题**：`querySelector` 只返回文档顺序里的第一个匹配，也就是 PDF 栏的按钮。两个处理函数都绑在它上面。
- **后果**：侧栏右上角的 ✕ **完全没有反应**；点 PDF 视图的 ✕ 会同时关闭 PDF 视图和侧栏。
- **修复建议**：改名（比如 `.panelclose` 和 `.pdfclose`），或者把查询范围限定在各自的容器里（`this.$('.panel .pclose')`）。更根本的做法是 `buildDom` 时一次性取出所有需要的元素引用，并断言每个选择器正好匹配一个元素。

### S2 🟠 `LitePlayer` 是"上帝类"（1,600 行、约 90 个方法）
- **位置**：`40-player.js`
- **问题**：一个类同时负责 DOM 构建、布局和拖拽、两路流和清晰度、键盘（40 个分支的 switch）、进度条交互、浮窗、复制、字幕菜单、音频菜单、静音 UI、章节标记、PDF 视图、笔记和讨论的接线、toast 和错误框、设置持久化。`bindControls()` 约 195 行，`bindVideo()` 约 75 行。
- **初始化顺序是隐式依赖**：构造函数里 `setupSilence()` 必须在 `loadCues()` 之前（后者会调用 `this.silence.start`），`setupSlides()` 必须在 `setupDeck()` 之前，`bindControls()` 顺带创建了 `this.zoom` 和 `this.loop`（`applyLayout` 和 `onKey` 要用到它们）。调换任意两行都会出现 `undefined` 错误，而且不会被测试发现。
- **建议**：按职责拆出 `SeekBar`、`KeyboardShortcuts`、`LayoutController`（含 PiP 和分隔条）、`QualityController`、`MenuBar`、`PopoutController`、`SilenceUi`。播放器只负责组装，在构造函数里显式传入依赖。

### S3 🟡 组件反向依赖播放器内部，耦合方向混乱
- `ABLoop` 通过 `this.p.$('.speedmenu').parentElement` 找挂载点，还直接调用 `p.toast/p.seek/p.duration`
- `SlideReader` 读 `player.deck` 和 `player.video`；`SlidesPane` 调用 `player.setPdfMain` 并读 `player.prefs`
- `Exporter` 直接读 `p.notes.items`、`p.tags`、`p.deck`、`p.lesson`
- `NotesPane` 读 `player.tags`、`p.sidebar`、`p.deck`，还在 `exportPanel` 里 new 一个 `Exporter`
- `DiscussionPane` 调用 `this.p.opts.onFallback('attachment')`
- 播放器给 `Stream` 实例**从外部挂属性** `stream.renewedAt`（`recoverAccess`）
- **建议**：组件只接收需要的最小接口（比如 `{ seek, currentTime, toast }`），不要拿整个 player。跨组件通信用事件或回调。

### S4 🟡 生命周期归属不一致（三种写法混用）
- 方式 A：接收播放器的 Disposer（`SessionKeeper`、`SilenceAnalyzer`、`SlideAnalyzer`、`SlideDeckController`、`Zoomer`、`ABLoop`）
- 方式 B：自己 new 一个 Disposer，由播放器手动调用 `dispose()`（`TranscriptPanel`、`NotesPane`、`DiscussionPane`、`SlidesPane`、`Sidebar`）
- 方式 C：`this.d.child()`（只有 `Reporter`）
- 另外 `Sidebar.dispose()` 会 dispose 所有已注册的面板，而播放器在第 160 行和第 1205 行又各自 dispose 了一遍，存在**双重归属**（`Disposer` 可以重复调用，所以暂时没出错）。
- **建议**：统一为"构造时传入 `parent.child()`"一种写法，谁创建谁持有。

### S5 🟡 全局可变状态
- `mediaSession.renew`（`36-session.js`）：任何地方都能读写。dispose 时 `if (mediaSession.renew) mediaSession.renew = null`，如果以后同一页面出现第二个 `SessionKeeper`，旧实例的 dispose 会清掉新实例的回调。
- `idbCache.db`（含被缓存的失败 Promise）、`sigCtx`、`crcTable`、`tesseractPromise`、`pdfjsPromise`（加上全局 Worker）、`unexpected.handler`、`cpuFix` 的内部状态
- 对 `window.Echo` 的 `defineProperty` 劫持（必须这样做，但没有恢复路径）
- **建议**：把与单次播放相关的状态（`mediaSession`、OCR/pdf.js 引擎）挂到播放器上下文里，而不是放在模块全局。

### S6 🟡 重复代码
| 重复内容 | 出现位置 |
|---|---|
| `duration()`：优先 `video.duration`，否则用 `lesson.duration` | `LitePlayer`、`SilenceAnalyzer`、`SlideAnalyzer` |
| 拼缩略图 URL `baseUri + '/' + t + '.' + extension` | `thumbnailFor`（11）、`previewAt`（40）、`loadThumb` 和 `fromThumbnailsAsync`（56） |
| 在进度条上用百分比画 `<i>` 条 | `renderSilences`、`renderWatched`、`renderChapterMarks`、`TranscriptPanel.renderMarks`、`MarkersLayer.render` |
| "点两次才删除"按钮 | `NotesPane.deleteButton`、`DiscussionPane.deleteButton`、`tagManager` |
| 后台分析器的骨架（AbortController、BackgroundGate、state/progress/onChange、`v:1` 缓存、saveData 检查） | `SilenceAnalyzer`、`SlideAnalyzer`、`SlideTextReader` |
| 解析 master 播放列表 | `pickAudioRendition`（54）、`videoVariants`（56） |
| `OffscreenCanvas` 不可用时退回 `<canvas>` | `sigContext`、`flatShare` |
| 请求 syllabus | `courseList.syllabus`、`Exporter.course` |
| 判断 hostname 是否为 Echo360 | `echo360ClassroomAdapter.matches`、`courseList.matches` |
| `navigator.connection.saveData` 检查 | 54、56、58 三处 |

### S7 ⚪ 死代码和过度抽象
- `35-stream.js:81` 的 `get level()`：没有任何地方使用
- `36-session.js` 的 `renewals`：只写不读
- `54-silence.js` 的 `SilenceAnalyzer.stats`：只写不读；`speechSpans()`：只在测试和注释里出现（"为以后的功能预留"）
- `56-slides.js:631` 的 `this.reader = reader`：只写不读
- `ADAPTERS` 数组和适配器接口只有一个实现；`adapter.matches` 接受任意 `echo360.*` 域名，但 `@match` 只放行 `echo360.net.au`，两边不一致
- `01-i18n.js` 的多语言框架（`LANG` 写死为 `'en'`）
- 建议删除，或者明确标注"保留给 Mx 里程碑"并附上计划链接。

### S8 ⚪ 文件组织
- 加载顺序依赖文件名的数字前缀。有两个 `47-`、两个 `58-`。`58-slide-text.js` 第 4 行注释说读屏在"59-slide-ocr.js"，实际是 `58-slide-ocr.js`。
- 通用工具散落在业务文件里：DOM 辅助函数 `h()` 定义在 `46-sidebar.js`；`seg()` 在 `11-echo360-api.js`，却被 `85-export.js` 使用；`parseAttrs` 在 `53` 里，被 `56` 使用；`FLAG_SCENE_SECONDS` 来自 API 模块，被播放器使用。
- **建议**：把 `h`、`seg`、`parseAttrs`、canvas 辅助函数搬到 `00-util.js` 或 `02-dom.js`；中长期可以考虑 ES 模块加 esbuild 打包，设置成不压缩、保留可读性，Greasy Fork 也能接受这样的输出。

---

## 5. 并发和竞态

> 前面说过，页面内没有切换录像的路径，所以"旧录像的任务结果写进新录像"这种典型问题不存在；后台分析在 dispose 后都会被 `AbortController` 中止，回调里也普遍检查了 `this.destroyed`，这一点做得不错。真正的竞态集中在**用户操作的并发**和**同一组件的多次异步加载**上。

### C1 🟠 重复提交：公开帖子、回复、笔记都可能发两遍（已确认）
- **位置**：`48-discussion.js` 的 `post()`（220 行）、`renderReplyComposer` 里的 `submit`（202 行）；`47-notes.js` 的 `addNote()`（198 行）
- **问题**：防重只靠 `button.disabled`，但 **Ctrl+Enter 的键盘路径不检查按钮状态**。文本框在请求完成前保持原内容，所以快速按两次 Ctrl+Enter（或者按一次、再点一次按钮）就会发出两个写请求。
- **后果**：在全班和老师都能看到的讨论区里出现重复帖，用户还得手动删除。笔记也会重复。
- **修复建议**：每个组件维护一个 `this.busy` 标志，函数入口 `if (this.busy) return; this.busy = true; try {…} finally { this.busy = false; }`。不要依赖 DOM 的 disabled 状态。

### C2 🟠 `DiscussionPane.load()` 的多个请求结果可能乱序覆盖
- **位置**：`48-discussion.js:28`
- **问题**：`load()` 会被多处并发调用：每次写入后调用一次，打开标签页时（超过 60 秒）调用一次，点"刷新"调用一次。没有序号或取消机制，**先发出、后返回**的旧响应会覆盖新响应。
- **后果**：刚发的帖子或刚点的赞在列表里"闪一下又消失"，等下次刷新才出现。
- **修复建议**：`const seq = ++this.loadSeq; … if (seq !== this.loadSeq) return;`，或者用 AbortController 取消上一次请求。

### C3 🟠 `tagHere` 在添加书签失败时会给另一个书签打标签（已确认）
- **位置**：`47-notes.js:338`
- **问题**：附近没有笔记时调用 `await this.addBookmark(e)`。这个函数**内部吞掉了异常**，失败时只弹出 toast。接下来的代码"从所有书签里挑一个离当前时间最近的"，不管它离得多远（可能是 40 分钟前的书签），然后打开它的标签选择器。
- **修复建议**：让 `addBookmark` 返回新建的条目（失败时返回 null），`tagHere` 直接使用这个返回值。

### C4 🟡 IndexedDB 的"读、改、写"不是原子操作
- `59-slide-deck.js` 的 `addFiles`/`removeFile` 处理 `deckref:<hash>`：先 `get`，再 `put` 或 `del`，分成两个事务。同一页面里并发增删，或者**两个标签页**（两门课用同一个 PDF）同时删除，可能丢失引用，导致**仍被另一个录像使用的 PDF 被删掉**，或者变成永远删不掉的孤儿数据。
- `43-watched.js` 的 `save()`：两个标签页打开同一节课时，各自用"加载时的 base 加上本页播放过的部分"覆盖写入，后写的一方会抹掉另一方的观看记录。
- 设置 `prefs` 整体覆盖写入：多个标签页互相覆盖（影响小）。
- **建议**：用单个 `readwrite` 事务完成"读、改、写"（`idbCache.update(key, fn)`）；观看记录写入前先重新读取再合并。

### C5 🟡 恢复备份之后，当前页面会用旧数据覆盖刚恢复的数据
- **位置**：`85-export.js` 的 `restoreBackup`；`40-player.js` 的 `pagehide → watched.save()`、dispose 时的 `store.set('prefs', this.prefs)`、`savePrefs` 防抖写入
- **问题**：恢复后提示用户重新加载页面，但重新加载触发的 `pagehide` 会把内存里的旧观看数据写回 `watched:<当前课>`；之后的任何设置改动也会把旧的 `prefs` 写回去。
- **后果**：当前这节课恢复的观看进度丢失，设置也可能被还原。
- **修复建议**：恢复成功后设置 `this.restored = true`，阻止后续写入并立即 `location.reload()`；或者恢复时跳过当前录像的相关键。

### C6 🟡 `TagStore` 加载完成之前的写入会覆盖已存数据（潜在问题）
- **位置**：`47-tags.js`：`ready` 标志存在，但所有写方法都不检查它
- **问题**：`load()` 还没完成时调用 `create/toggle`，会把空的 `this.tags` 或 `this.map` 写进 IndexedDB，覆盖课程已有的标签。目前笔记要等网络请求返回才可用，比本地读取标签慢得多，所以实际上很难触发；但以后改动加载顺序就会出现。
- **修复建议**：写方法先 `await this.loaded`。

### C7 ⚪ 其他小竞态
- `togglePopout` 是 async 函数，在 `requestWindow` 返回之前 `this.popout` 还是 null，连按两次 W 会发起两次窗口请求。
- `recoverAccess`：续期期间用户切换了视图（`loadClock` 换了 hls 实例），续期完成后的 `stream.resume()` 作用在新实例上。目前基本无害，但语义不对。
- `SlideDeckController.decide`：用 `this.job` 防止旧 PDF 的结果写进来，这一点是对的；但修正（`correct`）发生在 Worker 计算期间时，依赖 `again` 标志补算一次，`again` 没有在 `reload()` 时重置。

---

## 6. 测试覆盖

**现状**：一个文件 27 个测试，覆盖纯函数和少量类：时间格式化、Disposer、PlayedRanges、FollowerSync、CueIndex、VTT、AudioChain 的接线、API 路径、播放列表和 MP4 解析、静音检测、章节构建、PDF 跟读的 HMM、SessionKeeper、TagStore、zip 和 Markdown、字幕摘录。对纯算法而言质量不错。

### T1 🟠 最需要补的测试（按价值排序）
1. **`adapter.parse` 和 `intercept`**（`10-adapter-echo360.js`）：它决定接管还是回退，是和 Echo360 页面耦合最深、最容易随站点更新失效的部分，目前**零测试**。建议保存一份脱敏后的真实 `echoPlayerV2FullApp` 启动 JSON 作为 fixture，覆盖：正常、直播、版权确认、没有 HLS、单路和双路源、`withStartTime` 的往返转换；`intercept` 要覆盖三种情况：先赋值 `window.Echo` 后设置属性、先设置属性后赋值、通过 `defineProperty` 直接定义。
2. **播放器的创建和销毁**：在 jsdom 或 happy-dom 里加上假的 `HlsLib`，验证 `new LitePlayer(...)` 再 `destroy()` 之后，宿主元素被移除、`overflow` 恢复、没有残留的 interval 和 timeout、`mediaSession.renew` 为 null。同时验证 **E1**（构造中途抛异常后的清理）和 **L1**（续期进行中被 dispose）。
3. **`Reporter`**：上报内容（played 区间、position、生命周期顺序 BEGIN、beacon、END 只发一次）、401 后刷新令牌并重试一次、detach 之后不再发送。上报数据可能影响出勤统计，出错的代价高。
4. **`Echo360Api` 的写保护**：没有可信手势（`isTrusted` 为 false）时必须拒绝；dryRun 为 `public`/`all` 时的路由。这是"不会在用户不知情时向 Echo360 写数据"这一承诺的唯一保障。
5. **`sanitizePrefs` 和 `restoreBackup`**（修复 E2 后）：非法值回到默认值；备份往返一致；非本程序的键被拒绝。
6. **`slideTextWorkerSource()`**：在 `vm` 里执行这段源码，再调用 `followLecture`，结果应该和主线程一致。Worker 源码是用 `Function.prototype.toString` 拼接出来的，只要有人在这些函数里用了一个外部辅助函数（比如 `clamp`），主线程的测试照样通过，Worker 里却会抛 ReferenceError，导致 PDF 跟读完全失效（而且 `SlideTextWorker` 在 Worker 脚本加载失败后不会重建，后续请求会**永远挂起**）。
7. **`SlideDeckController`** 的 `forces/correct/pageAt/timesOf/partAt/followSamples` 边界：时长为 NaN、没有 OCR、修正区间重叠。
8. **`Stream.onError` 的重试策略**和 `applyQuality`/`levelFor`：用假的 hls 对象，验证 401/403 走续期、网络错误重试 4 次、媒体错误恢复 2 次后才判定致命。
9. **并发问题回归**：C1（Ctrl+Enter 两次只发一个请求）、C2（乱序响应）、C3。

### T2 🟠 标注数据没人使用
- `test/fixtures/slides-2026-09-15-elec2134.json`、`slides-2026-09-24.json`、`slides-2026-09-28.json` 是人工标注的"每章对应哪一页"真值，测试文件里没有任何地方引用它们。H2 和 H3 那些在少数课程上调出来的阈值因此没有回归保护。
- 目前 fixture 里只有时间和页码，没有 OCR 文本和画面签名，无法直接回放。**建议**：同时保存 OCR 文本（`texts/at`）和 PDF 页面文本，用 `followLecture` 计算准确率并设一个下限（比如 ≥ 90%）；做不到就删掉这些文件，免得误导读者以为有回归保护。

### T3 🟡 测试基础设施
- 测试文件开头注释写的命令 `node --test test/` 在 Node 22 上**直接报错**（`Cannot find module '/home/user/echo360-lite/test'`，已复现）。只有 `node --test test/unit.test.mjs` 能运行。
- 没有 `package.json`，因此没有 `npm test`、没有 lint、也没有 CI。一个 PR 改坏了构建或测试，不会有任何东西拦住它。
- `loadSources()` 用 `f.includes(n)` 子串匹配加载源文件，传 `'47-'` 这样的名字会同时加载 notes 和 tags 两个文件，比较脆弱。
- 建议：增加最小的 `package.json`（`"test": "node --test test/*.test.mjs"`、`"build": "node build.mjs"`），加一个 GitHub Actions 运行构建和测试，并检查 `dist/` 是否和源码同步。

---

## 7. 可维护性：一个只懂一点 JS 的人想读懂这个项目，最大的障碍

按影响从大到小排列。

1. **没有模块系统，看不出一个名字从哪来。** 32 个文件被拼接进同一个 IIFE，所有顶层名字共享一个作用域。读到 `idbCache`、`h(...)`、`t(...)`、`seg(...)`、`FLAG_SCENE_SECONDS` 时，只能全局搜索才知道定义在哪；编辑器的"跳转到定义"也常常失效。哪个模块依赖哪个模块，只能从文件名的数字前缀猜。
2. **`t` 和 `h` 被大量遮蔽。** `t()` 是翻译函数，`h()` 是 DOM 构造函数，但代码里到处用 `t` 作时间变量（`update(t)`、`previewAt(t)`，`53-media-io.js:20`、`54-silence.js:257`、`56-slides.js:111` 的 `let t = 0`），用 `h` 作高度或 hls 变量（`35-stream.js` 的 `const h = this.hls`，`40-player.js:401` 的 `const h = shown.height`）。初学者在这些函数里加一行 `t('xxx')` 或 `h('div')`，就会得到 "t is not a function"，而且很难看懂原因。**建议**把翻译函数重命名为 `tr`/`i18n`，DOM 辅助函数重命名为 `el`，并启用 ESLint 的 `no-shadow`。
3. **一个 1,600 行的类，初始化顺序是隐式的**（见 S2）。想改"进度条"得先在 90 个方法里找到 `bindControls` 中间那 60 行。
4. **回调链很长，没有图示。** 例如"加入 PDF 后页面怎么翻到正确的那一页"：`addFiles → reload → startReading → SlideTextReader.run → onChange → readingChanged → decide → Worker → onChange → player.applyLayout → reader.update → showPage → drawInto`，横跨 5 个文件。全靠事件回调串联，打断点也很难跟下去。
5. **领域知识密度极高，却没有参考资料。** 代码里有 MP4 box 解析、WebCodecs、Web Audio 动态处理、tf-idf、EM 拟合高斯混合、隐马尔可夫模型加 Viterbi、Echo360 的私有接口（包括"用 GET 删除标记"这种怪行为）、styled-components 4 的内部结构（cpufix）。注释说明了"做什么"，但缺少"为什么"的依据，比如阈值的来源数据、Echo360 接口是怎么抓到的，也没有外部链接。
6. **单字母和缩写命名**：`p, d, v, f, k, r, a, b, n, tg, rd, ev, ts, fs, sp, qp`，加上 `M`、`V`、`N`、`B`（Viterbi 部分）。在算法代码里可以接受，在 UI 代码里会明显增加阅读负担。
7. **数据结构没有类型说明。** `lesson`、`chapter`、`page`、`note`、`cue`、各种缓存记录的格式只在部分文件头的注释里有，而且分散在各处。建议用 JSDoc 的 `@typedef` 集中定义，再配合 `// @ts-check` 让编辑器给出补全和类型检查，不需要改成 TypeScript。
8. **注释里的里程碑编号（M7.5、M8.4、M10……）指向仓库里不存在的计划文档。** 外人看不懂；`CHANGELOG` 也只是面向用户的说明。
9. **`dist/` 里的生成文件被提交进仓库，而且有 8,700 行。** 新人可能直接改 `dist/`，下次构建就被覆盖。建议在 README 的开发者章节里写清楚"只改 `src/`"，并用 CI 检查 `dist/` 和源码一致。

**建议补一份 `ARCHITECTURE.md`（1–2 页）**，内容包括：模块地图（每个文件一句话，加上依赖关系）、启动流程（`main → intercept → parse → LitePlayer`）、生命周期规则（谁持有 Disposer）、三条后台分析流水线的示意图、所有缓存键及其格式、调试开关（`echo360lite:debug`、`dryRun`、`silenceFromAudio`）。

---

## 附：做得好的地方（修改时应保留）

- `Disposer` 加 `guard` 的组合，让大多数资源都能一次性释放；后台任务普遍使用 `AbortController` 并检查 `signal.aborted`。
- `BackgroundGate`：所有后台下载都让位于播放缓冲，并尊重 Data Saver。
- 所有写 Echo360 的操作都必须由可信的用户手势触发（`requireGesture`），并提供 dryRun 模式。
- 有明确的退路：一键切回原播放器，并保留播放位置；回退时还会启用 CPU 修复。
- 构建可复现（本次运行 `node build.mjs` 后，`dist/` 没有任何差异），构建时还会检查源码中不能出现 CJK 字符。
- 纯算法部分（章节、静音、HMM、播放列表和 MP4 解析）都有单元测试。

## 附：建议的修复顺序

1. **立刻修**：E1、E2、S1、C1，都是小改动，收益最大。
2. **下一个版本**：L1、L2、L3、L4、E3/E4（功能级容错）、E5、C2、C3、补 T1 的第 1–4 项，加上 `package.json` 和 CI。
3. **中期**：拆分 `LitePlayer`（S2/S3/S4），集中配置常数（H1–H6）并给缓存加算法版本号（H5），支持非英文 OCR（H3），清理 IndexedDB（L7），写 `ARCHITECTURE.md`。
