"""End-to-end integration test: project creation + file upload + parse + score retrieval."""
import asyncio
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from httpx import ASGITransport, AsyncClient
from app.main import app

SAMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Violin</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>1</duration><type>quarter</type>
      </note>
      <note>
        <pitch><step>B</step><octave>4</octave></pitch>
        <duration>1</duration><type>quarter</type>
      </note>
      <note>
        <pitch><step>C</step><alter>1</alter><octave>5</octave></pitch>
        <duration>1</duration><type>quarter</type>
      </note>
      <note>
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>1</duration><type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""


async def test_full_flow():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Create project
        r = await client.post("/api/projects", json={"title": "Integration Test", "instrument": "violin"})
        assert r.status_code == 200, f"Create project failed: {r.text}"
        project = r.json()
        pid = project["id"]
        print(f"[OK] Created project: {pid}")

        # 2. Upload MusicXML
        files = {"file": ("test.musicxml", BytesIO(SAMPLE_MUSICXML.encode()), "application/xml")}
        r = await client.post(f"/api/projects/{pid}/score-file", files=files)
        assert r.status_code == 200, f"Upload failed: {r.text}"
        print(f"[OK] Uploaded score file: {r.json()['file_id']}")

        # 3. Parse score
        r = await client.post(f"/api/projects/{pid}/parse-score")
        assert r.status_code == 200, f"Parse failed: {r.text}"
        parse_result = r.json()
        assert parse_result["note_groups_count"] == 4
        print(f"[OK] Parsed score: {parse_result['note_groups_count']} note groups")

        # 4. Get score data
        r = await client.get(f"/api/projects/{pid}/score")
        assert r.status_code == 200
        score = r.json()
        assert len(score["note_groups"]) == 4
        assert score["musicxml_url"] is not None
        print(f"[OK] Score data: musicxml_url={score['musicxml_url']}, {len(score['note_groups'])} groups")

        # 5. Get playback timeline
        r = await client.get(f"/api/projects/{pid}/playback-timeline?bpm=120")
        assert r.status_code == 200
        timeline = r.json()
        assert timeline["bpm"] == 120
        assert len(timeline["events"]) == 4
        print(f"[OK] Playback timeline: {timeline['total_duration']}s, {len(timeline['events'])} events")

        # 6. Upload performance (recording)
        audio_data = b"RIFF" + b"\x00" * 200
        files = {"file": ("practice.wav", BytesIO(audio_data), "audio/wav")}
        r = await client.post(f"/api/projects/{pid}/performances", files=files)
        assert r.status_code == 200
        perf_id = r.json()["performance_id"]
        print(f"[OK] Uploaded performance: {perf_id}")

        # 7. Analyze performance (mock scoring)
        r = await client.post(f"/api/performances/{perf_id}/analyze")
        assert r.status_code == 200
        analysis = r.json()
        assert analysis["status"] == "analyzed"
        print(f"[OK] Analyzed: total_score={analysis['total_score']}")

        # 8. Get diff report
        r = await client.get(f"/api/performances/{perf_id}/diff")
        assert r.status_code == 200
        diff = r.json()
        assert "summary" in diff
        assert "issues" in diff
        assert "color_map" in diff
        assert "measure_scores" in diff
        print(f"[OK] Diff report: {len(diff['issues'])} issues, {len(diff['color_map'])} colored notes")

        # 9. Get performance result
        r = await client.get(f"/api/performances/{perf_id}/result")
        assert r.status_code == 200
        result = r.json()
        assert result["total_score"] is not None
        assert len(result["note_results"]) == 4
        print(f"[OK] Performance result: {len(result['note_results'])} note results")

        # 10. Delete project and related data
        r = await client.delete(f"/api/projects/{pid}")
        assert r.status_code == 200, f"Delete project failed: {r.text}"
        assert r.json()["status"] == "deleted"
        r = await client.get(f"/api/projects/{pid}")
        assert r.status_code == 404
        print("[OK] Deleted project and related records")

        print("\n=== ALL INTEGRATION TESTS PASSED ===")


if __name__ == "__main__":
    asyncio.run(test_full_flow())
