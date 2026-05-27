"""Test MIDI upload, parsing, and conversion."""
import asyncio
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from music21 import stream, note, meter

from app.services.score_parser import parse_midi_to_note_groups, convert_midi_to_musicxml


def create_test_midi(output_path: Path):
    """Create a simple MIDI file with 4 notes using music21."""
    s = stream.Score()
    p = stream.Part()
    m = stream.Measure(number=1)
    m.append(meter.TimeSignature("4/4"))
    m.append(note.Note("A4", quarterLength=1.0))
    m.append(note.Note("B4", quarterLength=1.0))
    m.append(note.Note("C#5", quarterLength=1.0))
    m.append(note.Note("D5", quarterLength=1.0))
    p.append(m)
    s.append(p)
    s.write("midi", fp=str(output_path))
    return output_path


# Create test MIDI
test_midi = Path("data/test_upload.mid")
test_midi.parent.mkdir(parents=True, exist_ok=True)
create_test_midi(test_midi)
print(f"[OK] Created test MIDI: {test_midi}")

# Test parse_midi_to_note_groups
groups = parse_midi_to_note_groups(str(test_midi))
print(f"[OK] Parsed {len(groups)} note groups from MIDI")
for g in groups:
    print(f"  m{g['measure']} beat={g['beat']} {g['target_names']} type={g['type']}")

assert len(groups) >= 4, f"Expected at least 4 groups, got {len(groups)}"
non_rest = [g for g in groups if g["type"] != "rest"]
assert len(non_rest) >= 4, f"Expected at least 4 non-rest groups, got {len(non_rest)}"

# Test convert_midi_to_musicxml
musicxml_out = Path("data/test_from_midi.musicxml")
convert_midi_to_musicxml(str(test_midi), str(musicxml_out))
assert musicxml_out.exists()
assert musicxml_out.stat().st_size > 100
print(f"[OK] Converted MIDI → MusicXML ({musicxml_out.stat().st_size} bytes)")

# Test API integration
from httpx import ASGITransport, AsyncClient
from app.main import app


async def test_api():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create project
        r = await client.post("/api/projects", json={"title": "MIDI Test", "instrument": "violin"})
        assert r.status_code == 200
        pid = r.json()["id"]

        # Upload MIDI file
        midi_bytes = test_midi.read_bytes()
        files = {"file": ("test.mid", BytesIO(midi_bytes), "audio/midi")}
        r = await client.post(f"/api/projects/{pid}/score-file", files=files)
        assert r.status_code == 200
        print(f"[OK] Uploaded MIDI file: {r.json()['file_id']}")

        # Parse score (should detect MIDI and process it)
        r = await client.post(f"/api/projects/{pid}/parse-score")
        assert r.status_code == 200
        result = r.json()
        assert result["source"] == "midi"
        assert result["note_groups_count"] >= 4
        print(f"[OK] Parsed MIDI via API: {result['note_groups_count']} groups, source={result['source']}")

        # Verify score data is available
        r = await client.get(f"/api/projects/{pid}/score")
        assert r.status_code == 200
        score = r.json()
        assert score["musicxml_url"] is not None
        assert len(score["note_groups"]) >= 4
        print(f"[OK] Score data available: musicxml_url={score['musicxml_url']}, {len(score['note_groups'])} groups")


asyncio.run(test_api())

# Cleanup
test_midi.unlink()
musicxml_out.unlink()
print("\n=== MIDI UPLOAD & PARSE TEST PASSED ===")
