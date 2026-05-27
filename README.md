# ScoreDiff

个人小提琴智能练琴工具 — 上传乐谱，录制演奏，获得逐音符的 Diff 反馈。

## 功能概览

- 上传 MusicXML / MIDI / MP3 乐谱源（或图片/PDF 触发 OMR 预处理）
- MIDI 与 MP3 互相转换，自动生成 MusicXML / MIDI / MP3 导出文件
- 浏览器内电子谱渲染（OpenSheetMusicDisplay）与多行可编辑五线谱
- 所见即所得修谱：点选音符、纵向拖动改音高、编辑小节/拍号位置/时值并保存
- 电子谱动态播放：播放条驱动当前音符高亮和播放指示线
- 浏览器录音，自动上传分析
- 真实音频分析：pYIN 音准检测 + onset 节奏对齐 + CQT 双音识别
- 五维评分：音准 / 节奏 / 完整度 / 稳定性 / 总分
- Diff 可视化：谱面音符着色 + 问题列表 + 小节热力图
- 异步任务 + 进度轮询

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16, TypeScript, Tailwind CSS v4, shadcn/ui, OSMD |
| 后端 | FastAPI, SQLModel, SQLite (aiosqlite), fakeredis |
| 音频分析 | librosa (pyin, onset, CQT, DTW), numpy, scipy |
| 乐谱解析与转换 | music21, pretty_midi, ffmpeg, soundfile, HOMR, OpenCV (OMR) |
| 包管理 | uv (后端), npm (前端) |

## 端到端流程与技术说明

### 1. 创建项目

用户在前端点击「新建」后，Next.js 客户端通过 `fetch` 调用 FastAPI 的 `POST /api/projects`。后端使用 Pydantic 校验请求体，使用 SQLModel 写入 SQLite，项目初始状态为 `created`。

涉及技术：
- 前端：Next.js App Router、React state、TypeScript API client
- 后端：FastAPI 路由、Pydantic schema、SQLModel、SQLite/aiosqlite

### 2. 上传乐谱源

前端通过浏览器原生文件选择器上传 `.musicxml`、`.xml`、`.mid`、`.midi`、`.mp3`、`.pdf`、`.png`、`.jpg`、`.jpeg`、`.webp`。后端用 `python-multipart` 接收文件，并把原始文件保存到 `backend/data/uploads/`，同时在 `score_files` 表里记录文件类型和路径。

涉及技术：
- 前端：`FormData`、Fetch API、文件扩展名限制
- 后端：FastAPI `UploadFile`、`python-multipart`、SQLModel 文件记录
- 存储：本地文件系统 `backend/data/uploads/`

### 3. 解析为电子谱

上传后调用 `POST /api/projects/{id}/parse-score`。不同输入走不同解析链路：

| 输入 | 处理方式 | 产物 |
|---|---|---|
| MusicXML / XML | `music21.converter.parse` 解析音符，再用 music21 导出 MIDI | note_groups、MusicXML、MIDI |
| MIDI | music21 解析 MIDI 得到音符组，再导出 MusicXML | note_groups、MusicXML、MIDI |
| MP3 | librosa pYIN 提取单声部音高，pretty_midi 写 MIDI，再用 music21 转 MusicXML | note_groups、MIDI、MusicXML |
| PDF / 图片 | 优先调用 HOMR 识别 MusicXML；没有 HOMR 时尝试 Audiveris；都不可用时使用 OpenCV 预处理和五线谱线检测 | MusicXML 或预处理图 |

解析后的核心结构是 `note_groups`：每个元素包含小节、拍位、起止时间、目标 MIDI 音高、音名和类型。后续播放、评分、Diff 和修谱都围绕这个结构工作。

涉及技术：
- MusicXML/MIDI：music21
- MP3→MIDI：librosa pYIN、pretty_midi
- OMR 识别：优先 HOMR CLI / `uvx homr`；可选 Audiveris CLI；OpenCV、Pillow 作为预处理回退
- 数据落库：SQLModel `note_groups` 表

### 4. MIDI 与 MP3 转换

前端点击「MIDI」或「MP3」按钮后调用 `POST /api/projects/{id}/convert?target=midi|mp3`。

MIDI 目标优先复用已生成的 MIDI；如果只有 MusicXML，就用 music21 转 MIDI；如果只有 MP3，就先用 librosa + pretty_midi 生成 MIDI。MP3 目标会先确保项目有 MIDI，再用内置的轻量合成器把 MIDI 渲染为 WAV，最后调用 ffmpeg 编码为 MP3。

涉及技术：
- MIDI 读写：pretty_midi、music21
- 音频合成：numpy 正弦波叠加、soundfile 写 WAV
- MP3 编码：ffmpeg/libmp3lame
- 静态文件服务：FastAPI `StaticFiles` 暴露 `/files/...`

### 5. 修正电子五线谱

中央谱面默认进入「编辑谱」模式。前端用 SVG 根据 `note_groups` 绘制五线谱、音符、符杆和加线。用户可以点选音符、上下拖动改变 MIDI 音高，也可以在右侧属性面板修改小节、拍位和时值。点击「保存」后调用 `PUT /api/projects/{id}/score`。

后端保存时会清空该项目旧的 `note_groups`，写入新数据，再用 music21 从编辑后的 `note_groups` 重建 MusicXML，并重新导出 MIDI。如果项目已经有 MP3，也会尝试重新生成 MP3。

涉及技术：
- 前端：React、TypeScript、SVG、Pointer Events、Tailwind CSS
- 后端：FastAPI PUT 接口、Pydantic 入参、SQLModel 删除/重写
- 乐谱导出：music21 从 note_groups 构建 `Score`、`Part`、`Measure`、`Note`、`Chord`、`Rest`

### 6. 电子谱预览与播放时间线

「印刷谱」模式使用 OpenSheetMusicDisplay 加载后端暴露的 MusicXML 文件并渲染为排版谱。播放条通过 `GET /api/projects/{id}/playback-timeline` 获取按秒计算的事件序列，前端用 `requestAnimationFrame` 驱动播放进度，并把当前时间传给电子谱视图。编辑谱会根据当前时间高亮正在播放的音符，并显示竖向播放指示线。

涉及技术：
- 谱面渲染：OpenSheetMusicDisplay
- 时间线生成：后端根据 `note_groups.start/end` 计算事件
- 前端播放 UI：React state、Base UI Slider、requestAnimationFrame、SVG 当前音符高亮

### 7. 录音与演奏分析

浏览器使用 `MediaRecorder` 录制演奏，录音结束后通过 `POST /api/projects/{id}/performances` 上传。前端再调用 `POST /api/performances/{id}/analyze-async` 启动后台分析，并轮询 `/api/tasks/{id}/progress`。

真实分析模式由三个服务协同：
- `PitchService`：librosa pYIN 检测基频，换算 MIDI 音高和 cents 误差
- `RhythmService`：librosa onset detection 与对齐，计算进入时间偏差
- `PolyphonicService`：CQT 频谱峰值识别双音/和弦

异步进度使用 FastAPI `BackgroundTasks` 执行分析，fakeredis 保存进度缓存，SQLite 保存最终评分结果。

涉及技术：
- 前端录音：MediaRecorder、Blob、FormData
- 后端任务：FastAPI BackgroundTasks、fakeredis
- 音频分析：librosa、numpy、scipy
- 结果存储：SQLModel `performances`、`note_results`

### 8. Diff 反馈展示

后端把逐音符评分结果传给 `diff_service`，生成总分、分项分、小节分、问题列表和 `color_map`。前端用右侧问题面板展示错误/警告，用谱面颜色标注问题音符，并提供 Diff 详情弹窗。

涉及技术：
- 后端：规则映射、逐小节聚合、JSON 响应
- 前端：React 组件状态、Badge/Panel UI、OSMD 颜色覆盖、SVG 音符颜色

## 项目结构

```
ScoreDiff/
├── backend/
│   ├── app/
│   │   ├── api/routes.py          # FastAPI 路由
│   │   ├── core/config.py         # 配置
│   │   ├── core/redis.py          # fakeredis 客户端
│   │   ├── db/session.py          # SQLite 异步会话
│   │   ├── models/models.py       # SQLModel 数据模型
│   │   ├── schemas/schemas.py     # Pydantic 响应模型
│   │   ├── services/
│   │   │   ├── services.py        # 基础 CRUD 服务
│   │   │   ├── score_parser.py    # MusicXML/MIDI 解析 + 编辑谱导出
│   │   │   ├── audio_conversion_service.py # MIDI/MP3 转换
│   │   │   ├── playback_service.py
│   │   │   ├── recording_service.py
│   │   │   ├── scoring_service.py # Mock 评分
│   │   │   ├── real_scoring_service.py # 真实评分 (整合下面三个)
│   │   │   ├── pitch_service.py   # pYIN 音准检测
│   │   │   ├── rhythm_service.py  # Onset + DTW 节奏
│   │   │   ├── polyphonic_service.py # CQT 双音检测
│   │   │   ├── diff_service.py    # Diff 报告生成
│   │   │   └── omr_service.py     # HOMR/Audiveris/OpenCV 图片/PDF → MusicXML
│   │   └── main.py               # FastAPI app 入口
│   ├── tests/                     # 集成测试
│   ├── data/                      # 运行时数据 (自动创建)
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx           # 主页面 (三栏布局)
│   │   ├── components/
│   │   │   ├── project-sidebar.tsx
│   │   │   ├── score-viewer.tsx   # 多行可编辑五线谱 + 动态播放高亮 + OSMD 预览
│   │   │   ├── playback-bar.tsx
│   │   │   ├── practice-recorder.tsx
│   │   │   ├── issue-panel.tsx
│   │   │   ├── diff-viewer.tsx    # Diff 详情弹窗
│   │   │   └── task-progress-bar.tsx
│   │   └── lib/
│   │       ├── api.ts             # 后端 API 客户端
│   │       └── utils.ts
│   ├── next.config.ts             # API 代理配置
│   └── package.json
├── TODO.md
├── PROGRESS.md
└── README.md
```

## 快速开始

### 环境要求

- Python 3.10
- Node.js >= 18
- [uv](https://docs.astral.sh/uv/) (Python 包管理)
- ffmpeg（MIDI→MP3 导出需要）
- HOMR（可选但推荐；PDF/图片 OMR 生成 MusicXML 优先使用）
- Audiveris（可选；HOMR 不可用时的 OMR 回退）

HOMR 可直接安装为命令行工具。后端会自动探测 `homr`；如果希望通过 `uvx homr <image>` 临时运行，可以设置 `SCOREDIFF_ENABLE_UVX_HOMR=1`。识别顺序是 HOMR → Audiveris → OpenCV 预处理。

### 1. 启动后端

```bash
cd backend

# 安装依赖
uv sync

# 启动开发服务器 (默认 http://localhost:8000)
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

后端启动后可访问：
- API 文档: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### 2. 启动前端

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器 (默认 http://localhost:3000)
npm run dev
```

前端通过 `next.config.ts` 中的 rewrites 将 `/api/*` 和 `/files/*` 代理到后端。

### 3. 使用流程

1. 打开 http://localhost:3000
2. 点击「+ 新建」创建项目
3. 选中项目，点击「上传 PDF/MIDI/MP3」上传 `.musicxml`、`.mid/.midi`、`.mp3` 或图片/PDF
4. 系统解析为 `note_groups`，并生成 MusicXML/MIDI；可按需点击「MIDI」或「MP3」导出
5. 在中间「编辑谱」模式里点选音符，拖动或修改属性后点击「保存」
6. 点击「开始录音」录制演奏
7. 录音结束后自动分析，弹出 Diff 结果
8. 查看音符着色、问题列表、分数详情

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 项目列表 |
| GET | `/api/projects/{id}` | 项目详情 |
| POST | `/api/projects/{id}/score-file` | 上传乐谱源文件 |
| POST | `/api/projects/{id}/parse-score` | 解析 MusicXML/MIDI/MP3 为电子谱 |
| POST | `/api/projects/{id}/ocr` | OMR 图片转谱 |
| GET | `/api/projects/{id}/score` | 获取谱面数据 |
| PUT | `/api/projects/{id}/score` | 保存修正后的电子谱并重新导出 |
| POST | `/api/projects/{id}/convert?target=midi\|mp3` | MIDI/MP3 转换 |
| GET | `/api/projects/{id}/playback-timeline` | 播放时间线 |
| POST | `/api/projects/{id}/performances` | 上传录音 |
| GET | `/api/projects/{id}/recordings` | 录音列表 |
| POST | `/api/performances/{id}/analyze?mode=real` | 分析演奏 (mock/real) |
| POST | `/api/performances/{id}/analyze-async` | 异步分析 |
| GET | `/api/performances/{id}/result` | 分析结果 |
| GET | `/api/performances/{id}/diff` | Diff 报告 |
| GET | `/api/tasks/{id}` | 任务状态 |
| GET | `/api/tasks/{id}/progress` | 实时进度 |

## 运行测试

```bash
cd backend

# 完整集成测试
uv run python tests/test_integration.py

# 音高检测测试
uv run python tests/test_pitch.py

# 节奏检测测试
uv run python tests/test_rhythm.py

# 双音检测测试
uv run python tests/test_polyphonic.py

# 真实评分测试
uv run python tests/test_real_scoring.py

# OMR 测试
uv run python tests/test_omr.py

# MIDI/MP3 转换与修谱测试
uv run python tests/test_conversion_and_score_edit.py

# 异步任务测试
uv run python tests/test_task_progress.py
```

## 评分算法

分析模式 (`mode=real`) 使用三个服务协同工作：

- **PitchService**: librosa pYIN 基频检测 → 每个音符的 cents 误差 + 稳定性
- **RhythmService**: onset detection + 贪心对齐 → 每个音符的 ms 偏差
- **PolyphonicService**: CQT 频谱峰值 → 双音/和弦识别率

总分 = 音准×0.4 + 节奏×0.3 + 完整度×0.2 + 稳定性×0.1

## 许可证

本项目使用 GNU Affero General Public License v3.0 only，SPDX 标识为 `AGPL-3.0-only`。完整协议文本见 [LICENSE](LICENSE)。
