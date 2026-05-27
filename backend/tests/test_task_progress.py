"""Test async analysis with task progress polling."""
import asyncio
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from httpx import ASGITransport, AsyncClient
from app.main import app

SAMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>"""


async def test_async_analysis():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/api/projects", json={"title": "TaskTest", "instrument": "violin"})
        pid = r.json()["id"]

        files = {"file": ("t.musicxml", BytesIO(SAMPLE_MUSICXML.encode()), "application/xml")}
        await client.post(f"/api/projects/{pid}/score-file", files=files)
        await client.post(f"/api/projects/{pid}/parse-score")

        files = {"file": ("rec.wav", BytesIO(b"RIFF" + b"\x00" * 100), "audio/wav")}
        r = await client.post(f"/api/projects/{pid}/performances", files=files)
        perf_id = r.json()["performance_id"]

        # Start async analysis
        r = await client.post(f"/api/performances/{perf_id}/analyze-async")
        assert r.status_code == 200
        task_id = r.json()["task_id"]
        print(f"[OK] Async analysis started: task_id={task_id}")

        # Poll progress
        prog = None
        for _ in range(30):
            await asyncio.sleep(0.2)
            r = await client.get(f"/api/tasks/{task_id}/progress")
            assert r.status_code == 200
            prog = r.json()
            print(f"  progress={prog['progress']:.1f} status={prog['status']} msg={prog['message']}")
            if prog["status"] in ("completed", "failed"):
                break

        assert prog["status"] == "completed"
        assert prog["progress"] == 1.0
        print("[OK] Task completed")

        # Verify diff is available
        r = await client.get(f"/api/performances/{perf_id}/diff")
        assert r.status_code == 200
        print("[OK] Diff available after async analysis")

        print("\n=== TASK PROGRESS POLLING TEST PASSED ===")


if __name__ == "__main__":
    asyncio.run(test_async_analysis())
