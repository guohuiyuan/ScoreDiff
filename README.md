# ScoreDiff

个人小提琴智能练琴工具。上传乐谱或音频，生成可编辑电子五线谱，录制演奏后得到逐音符 Diff 反馈。

## 功能概览

- 项目管理：创建、选择、删除项目；删除项目会同步清理谱面、录音、分析结果和生成文件。
- 乐谱来源：支持 MusicXML、MIDI，以及 PDF/图片触发 OMR 流程。
- 导出：支持从 MusicXML 生成 MIDI 导出。
- OMR 识别：PDF/图片优先走 HOMR；不可用时尝试 Audiveris；最后回退到 OpenCV 预处理和五线谱线检测。
- 粘贴上传：侧边栏支持 Ctrl+V 粘贴乐谱截图，可累积多张后一次上传识别。
- 可编辑电子谱：多行五线谱浏览，选择模式、音符输入模式、时值工具、点谱输入、方向键改音高、底部检查器编辑小节/拍位/时值。
- MuseScore 风格编辑逻辑：先选时值，再输入音符；选中音符后改音高、位置和时值；保存后重建 MusicXML/MIDI。
- 时值网格修正：前端限制音符不跨出当前 4/4 小节，后端导出时按小节补休止并裁剪越界时值。
- 动态播放：播放条驱动当前音符高亮和播放指示线，浏览器用 Web Audio API 合成实际声音。
- 浏览器录音：使用 MediaRecorder 录制演奏并上传分析。
- 演奏分析：pYIN 音准检测、onset 节奏对齐、CQT 双音识别。
- Diff 反馈：总分、分项分、小节热力图、问题列表、谱面音符着色。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16, React, TypeScript, Tailwind CSS v4, shadcn/ui, lucide-react |
| 谱面渲染 | 自绘 SVG 编辑谱, OpenSheetMusicDisplay 印刷谱预览 |
| 播放 | Web Audio API, requestAnimationFrame, Base UI Slider |
| 后端 | FastAPI, Pydantic, SQLModel, SQLite/aiosqlite, fakeredis |
| 乐谱解析与转换 | music21, pretty_midi, pymupdf |
| OMR | HOMR (uvx), Audiveris, OpenCV |
| 音频分析 | librosa, numpy, scipy |
| 包管理 | uv (后端), npm (前端) |

后端使用 `uv` 管理依赖，项目不再需要 `requirements.txt`。依赖以 `backend/pyproject.toml` 和 `backend/uv.lock` 为准。

## 端到端流程与技术说明

### 1. 创建和删除项目

前端项目列表由 `ProjectSidebar` 管理。点击「新建」会调用 `POST /api/projects`，后端用 Pydantic 校验请求体，再通过 SQLModel 写入 SQLite。

项目列表里的删除按钮会调用 `DELETE /api/projects/{id}`。后端 `ProjectService.delete()` 会删除关联的 `performances`、`note_results`、`note_groups`、`score_files`、`tasks` 和项目本身；路由层再清理 `backend/data` 下该项目的上传文件、录音、MusicXML、MIDI、MP3、OMR 预处理图等产物。

涉及技术：
- 前端：React state、TypeScript API client、确认弹窗、列表局部更新
- 后端：FastAPI 路由、SQLModel 删除、SQLite 事务、本地文件清理

### 2. 上传乐谱源

前端支持两种上传方式：
- 文件选择器：上传 `.musicxml`、`.xml`、`.mid`、`.midi`、`.pdf`、`.png`、`.jpg`、`.jpeg`、`.webp`。
- 粘贴上传：在侧边栏底部的粘贴区域按 Ctrl+V 粘贴乐谱截图，可多次粘贴累积多张，点击"上传"一次性处理。

后端使用 `UploadFile` 接收文件，把原始文件保存到 `backend/data/uploads/`，并在 `score_files` 表中记录文件类型和路径。

涉及技术：
- 前端：FormData、Fetch API、文件扩展名限制
- 后端：FastAPI UploadFile、python-multipart、SQLModel
- 存储：本地文件系统 `backend/data/uploads/`

### 3. 解析为电子谱

上传后调用 `POST /api/projects/{id}/parse-score`。不同输入走不同链路：

| 输入 | 处理方式 | 产物 |
|---|---|---|
| MusicXML / XML | `music21.converter.parse` 解析音符，再导出 MIDI | note_groups, MusicXML, MIDI |
| MIDI | music21 解析 MIDI 得到音符组，再导出 MusicXML | note_groups, MusicXML, MIDI |
| PDF / 图片 | pymupdf 转 PNG，HOMR 识别 MusicXML；HOMR 不可用时尝试 Audiveris；都不可用时 OpenCV 预处理 | MusicXML 或预处理结果 |

解析后的核心结构是 `note_groups`。每个元素包含小节、拍位、起止时间、目标 MIDI 音高、音名和类型。后续播放、编辑、评分和 Diff 都围绕这个结构工作。

涉及技术：
- MusicXML/MIDI：music21
- PDF 转图片：pymupdf (fitz)
- OMR：HOMR CLI（通过 `uvx homr` 或直接 `homr`）、Audiveris CLI、OpenCV
- 数据落库：SQLModel `note_groups`

### 4. 导出 MIDI

前端点击「导出 MIDI」会调用 `POST /api/projects/{id}/convert?target=midi`。

生成 MIDI 时优先复用已有 MIDI；如果只有 MusicXML，用 music21 转 MIDI。

涉及技术：
- MIDI/MusicXML：music21、pretty_midi
- 文件访问：FastAPI StaticFiles 暴露 `/files/...`

### 5. 编辑电子五线谱

中央谱面默认进入「编辑谱」模式。前端用 SVG 按 `note_groups` 绘制多行五线谱、音符、符杆、旗尾、加线和时值辅助线。

编辑逻辑参考 MuseScore 的基本方式：
- 「选择」模式：点选音符，上下拖动或方向键调整音高。
- 「输入」模式：先选择 16分、8分、4分、2分、全音等时值，再点击五线谱写入音符。
- 底部检查器：编辑选中音符的音高、小节、拍位、时值。
- 保存：调用 `PUT /api/projects/{id}/score`，后端重新生成 MusicXML/MIDI。

为避免“音的长度不对”，前端保存前会把拍位量化到 1/4 拍，并限制音符结尾不能超过当前 4/4 小节。后端导出 MusicXML 时按小节顺序写入音符和休止符，填满空拍，并裁剪越界时值，避免 MusicXML 里出现重叠或跨小节导致的时值异常。

涉及技术：
- 前端：React、TypeScript、SVG、Pointer Events、键盘事件、Tailwind CSS
- 后端：FastAPI PUT、Pydantic 入参、SQLModel 删除/重写
- 导出：music21 构建 Score、Part、Measure、Note、Chord、Rest

### 6. 预览和动态播放

「排版谱」模式使用 OpenSheetMusicDisplay 加载后端生成的 MusicXML，渲染成更接近印刷谱的预览。

播放条调用 `GET /api/projects/{id}/playback-timeline` 获取按秒计算的事件序列。前端用 `requestAnimationFrame` 推进播放时间，把当前时间传给谱面视图，高亮正在播放的音符并显示竖向播放指示线。声音由 Web Audio API 根据 MIDI pitch 实时合成，不依赖外部音频文件。

涉及技术：
- 谱面预览：OpenSheetMusicDisplay
- 时间线：后端根据 `note_groups.start/end` 生成 playback events
- 播放 UI：React state、Base UI Slider、requestAnimationFrame
- 声音：AudioContext、OscillatorNode、GainNode

### 7. 录音和演奏分析

浏览器使用 `MediaRecorder` 录制演奏，结束后通过 `POST /api/projects/{id}/performances` 上传。前端再调用 `POST /api/performances/{id}/analyze-async` 启动后台分析，并轮询 `/api/tasks/{id}/progress`。

真实分析模式由三个服务协同：
- `PitchService`：librosa pYIN 检测基频，换算 MIDI 音高和 cents 误差。
- `RhythmService`：librosa onset detection 和对齐，计算进入时间偏差。
- `PolyphonicService`：CQT 频谱峰值识别双音和和弦。

涉及技术：
- 前端录音：MediaRecorder、Blob、FormData
- 后端任务：FastAPI BackgroundTasks、fakeredis
- 音频分析：librosa、numpy、scipy
- 结果存储：SQLModel `performances`、`note_results`

### 8. Diff 反馈展示

后端把逐音符评分结果传给 `diff_service`，生成总分、分项分、小节分、问题列表和 `color_map`。前端在有 diff 后显示右侧问题面板，并可打开详情弹窗；谱面根据 `color_map` 给问题音符着色。

涉及技术：
- 后端：规则映射、逐小节聚合、JSON 响应
- 前端：React 状态、问题面板、详情弹窗、SVG/OSMD 着色

## 项目结构

```text
ScoreDiff/
├── backend/
│   ├── app/
│   │   ├── api/routes.py              # FastAPI 路由
│   │   ├── core/config.py             # 配置
│   │   ├── core/redis.py              # fakeredis 客户端
│   │   ├── db/session.py              # SQLite 异步会话
│   │   ├── models/models.py           # SQLModel 数据模型
│   │   ├── schemas/schemas.py         # Pydantic 模型
│   │   ├── services/
│   │   │   ├── services.py            # 基础 CRUD 和项目删除
│   │   │   ├── score_parser.py        # MusicXML/MIDI 解析和编辑谱导出
│   │   │   ├── audio_conversion_service.py
│   │   │   ├── playback_service.py
│   │   │   ├── recording_service.py
│   │   │   ├── scoring_service.py
│   │   │   ├── real_scoring_service.py
│   │   │   ├── pitch_service.py
│   │   │   ├── rhythm_service.py
│   │   │   ├── polyphonic_service.py
│   │   │   ├── diff_service.py
│   │   │   └── omr_service.py         # HOMR/Audiveris/OpenCV
│   │   └── main.py
│   ├── tests/
│   ├── data/                          # 运行时数据，自动创建
│   ├── pyproject.toml
│   └── uv.lock
├── frontend/
│   ├── src/
│   │   ├── app/page.tsx               # 主页面布局
│   │   ├── components/
│   │   │   ├── project-sidebar.tsx    # 项目列表、上传、转换、删除
│   │   │   ├── score-viewer.tsx       # 多行可编辑五线谱 + OSMD 预览
│   │   │   ├── playback-bar.tsx       # 动态播放和 Web Audio 声音
│   │   │   ├── practice-recorder.tsx
│   │   │   ├── issue-panel.tsx
│   │   │   ├── diff-viewer.tsx
│   │   │   └── task-progress-bar.tsx
│   │   └── lib/api.ts                 # 后端 API 客户端
│   ├── package.json
│   └── package-lock.json
├── .gitignore
├── LICENSE
└── README.md
```

## 快速开始

### 环境要求

- Python 3.10+
- Node.js 18+
- uv
- HOMR，推荐安装，用于 PDF/图片 OMR 识别

### 配置 HOMR

HOMR 是将乐谱图片识别为 MusicXML 的核心工具。后端会自动探测可用的 HOMR 执行方式。

**方式一：通过 uvx 临时运行（推荐，无需安装）**

只要系统有 `uv`（后端包管理器），`uvx` 命令就可用。后端会自动调用 `uvx homr <image>` 运行 HOMR，首次运行时 uvx 会自动下载依赖。

```bash
# 验证 uvx 可用
uvx homr --help
```

**方式二：全局安装 homr**

```bash
pip install homr
# 或
pipx install homr
```

安装后确认 `homr` 在 PATH 中：

```bash
homr --help
```

**方式三：Docker**

HOMR 提供 CPU 和 GPU 两种 Docker 镜像，适合服务器部署。参考 [HOMR 仓库](https://github.com/liebharc/homr)。

**注意事项：**
- HOMR 只接受 PNG/JPG 图片，不直接接受 PDF。后端会自动用 pymupdf 将 PDF 转为 PNG 再送入 HOMR。
- HOMR 需要 Python 3.11+，但通过 uvx 运行时会自动使用隔离环境，不影响后端的 Python 3.10。
- 如果 HOMR 不可用，系统会尝试 Audiveris；都不可用时回退到 OpenCV 预处理（只检测五线谱线，不生成 MusicXML）。

### 启动后端

```bash
cd backend
uv sync --all-groups
uv run --all-groups uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

后端启动后可访问：

- API 文档：http://localhost:8000/docs
- ReDoc：http://localhost:8000/redoc

### 启动前端

```bash
cd frontend
npm install
npm run dev
```

开发环境默认前端为 http://localhost:3000，后端为 http://localhost:8000。前端 API 地址可通过 `NEXT_PUBLIC_API_URL` 指定。

## 使用流程

1. 打开前端页面。
2. 点击「新建」创建项目。
3. 选中项目，上传 MusicXML、MIDI、PDF 或图片（也可以在粘贴区域 Ctrl+V 粘贴乐谱截图）。
4. 系统解析为 `note_groups`，并生成 MusicXML/MIDI；需要时点击「导出 MIDI」下载。
5. 在「编辑谱」模式里用选择/输入模式修正音符，底部检查器可改音高、小节、拍位和时值。
6. 点击「保存」，后端重新生成 MusicXML/MIDI。
7. 点击播放条播放电子谱，当前音符会动态高亮并有声音。
8. 录制演奏，等待异步分析完成后查看 Diff。
9. 不再需要的项目可在项目列表直接删除。

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 项目列表 |
| GET | `/api/projects/{id}` | 项目详情 |
| DELETE | `/api/projects/{id}` | 删除项目和关联数据 |
| POST | `/api/projects/{id}/score-file` | 上传乐谱源文件 |
| POST | `/api/projects/{id}/ocr` | PDF/图片 OMR 识别 |
| POST | `/api/projects/{id}/parse-score` | 解析 MusicXML/MIDI 为电子谱 |
| GET | `/api/projects/{id}/score` | 获取谱面数据 |
| PUT | `/api/projects/{id}/score` | 保存修正后的电子谱并重新导出 |
| POST | `/api/projects/{id}/convert?target=midi` | 导出 MIDI |
| GET | `/api/projects/{id}/playback-timeline` | 播放时间线 |
| POST | `/api/projects/{id}/performances` | 上传录音 |
| GET | `/api/projects/{id}/recordings` | 录音列表 |
| POST | `/api/performances/{id}/analyze?mode=mock\|real` | 同步分析演奏 |
| POST | `/api/performances/{id}/analyze-async` | 异步分析演奏 |
| GET | `/api/performances/{id}/result` | 分析结果 |
| GET | `/api/performances/{id}/diff` | Diff 报告 |
| GET | `/api/tasks/{id}` | 任务状态 |
| GET | `/api/tasks/{id}/progress` | 实时进度 |

## 运行测试

```bash
cd backend

uv run --all-groups python tests/test_integration.py
uv run --all-groups python tests/test_midi_upload.py
uv run --all-groups python tests/test_omr.py
uv run --all-groups python tests/test_conversion_and_score_edit.py
uv run --all-groups python tests/test_task_progress.py
uv run --all-groups python tests/test_pitch.py
uv run --all-groups python tests/test_rhythm.py
uv run --all-groups python tests/test_polyphonic.py
uv run --all-groups python tests/test_real_scoring.py
```

前端检查：

```bash
cd frontend
npm run lint
npm run build
```

## 关键实现说明

- 电子谱编辑不是直接嵌入 MuseScore，而是在浏览器中基于 `note_groups` 自绘 SVG，并用 MuseScore 类似的输入模型组织交互。
- OpenSheetMusicDisplay 用于 MusicXML 的排版预览，不负责核心编辑。
- Web Audio 播放的是根据 `playback-timeline` 合成的参考音，不是录音文件回放。
- PDF/图片 OMR 是否能直接生成 MusicXML 取决于本机是否安装 HOMR 或 Audiveris；没有 OMR 引擎时仍会做 OpenCV 预处理并返回可诊断结果。
- PDF 文件会先通过 pymupdf 转为 300dpi PNG 再送入 HOMR（HOMR 不直接支持 PDF）。
- 后端导出 MusicXML 时会补齐小节内休止符，保证时值落在 4/4 小节网格上。

## 许可证

本项目使用 GNU Affero General Public License v3.0 only，SPDX 标识为 `AGPL-3.0-only`。完整协议文本见 [LICENSE](LICENSE)。
