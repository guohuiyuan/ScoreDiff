"""Tests for selected-segment comparison."""
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


async def test_sync_analysis_uses_selected_segment_only():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/api/projects", json={"title": "SegmentTest", "instrument": "violin"})
        assert r.status_code == 200, r.text
        pid = r.json()["id"]

        files = {"file": ("segment.musicxml", BytesIO(SAMPLE_MUSICXML.encode()), "application/xml")}
        r = await client.post(f"/api/projects/{pid}/score-file", files=files)
        assert r.status_code == 200, r.text
        r = await client.post(f"/api/projects/{pid}/parse-score")
        assert r.status_code == 200, r.text

        files = {"file": ("rec.wav", BytesIO(b"RIFF" + b"\x00" * 100), "audio/wav")}
        r = await client.post(f"/api/projects/{pid}/performances", files=files)
        assert r.status_code == 200, r.text
        perf_id = r.json()["performance_id"]

        r = await client.post(f"/api/performances/{perf_id}/analyze?segment_start=0.5&segment_end=1.0")
        assert r.status_code == 200, r.text
        assert r.json()["segment"]["start"] == 0.5
        assert r.json()["segment"]["end"] == 1.0
        assert r.json()["segment"]["note_count"] == 1

        r = await client.get(f"/api/performances/{perf_id}/diff")
        assert r.status_code == 200, r.text
        diff = r.json()
        assert len(diff["color_map"]) == 1
        assert diff["segment"]["start"] == 0.5
        assert diff["segment"]["end"] == 1.0
        assert diff["segment"]["note_count"] == 1
        assert diff["pitch_chart"]["reference"]
        assert diff["pitch_chart"]["segment"]["note_count"] == 1
        assert diff["pitch_chart"]["reference"][0]["name"] == "B4"
        print("[OK] Segment analysis only scored the selected note")


if __name__ == "__main__":
    asyncio.run(test_sync_analysis_uses_selected_segment_only())
