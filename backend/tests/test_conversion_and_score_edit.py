"""Test MP3/MIDI conversion and editable score persistence."""
import asyncio
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pretty_midi
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.audio_conversion_service import convert_audio_to_midi, convert_midi_to_mp3
from app.services.score_parser import parse_midi_to_note_groups


def create_test_midi(output_path: Path):
    midi = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=40, name="Violin")
    inst.notes.append(pretty_midi.Note(velocity=96, pitch=69, start=0.0, end=0.5))
    inst.notes.append(pretty_midi.Note(velocity=96, pitch=71, start=0.5, end=1.0))
    inst.notes.append(pretty_midi.Note(velocity=96, pitch=73, start=1.0, end=1.5))
    midi.instruments.append(inst)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    midi.write(str(output_path))
    return output_path


def test_conversion_services():
    source_midi = create_test_midi(Path("data/test_conversion_source.mid"))
    mp3_out = Path("data/test_conversion_source.mp3")
    roundtrip_midi = Path("data/test_conversion_roundtrip.mid")

    convert_midi_to_mp3(source_midi, mp3_out)
    assert mp3_out.exists()
    assert mp3_out.stat().st_size > 1000
    print(f"[OK] Converted MIDI -> MP3: {mp3_out.stat().st_size} bytes")

    convert_audio_to_midi(mp3_out, roundtrip_midi)
    assert roundtrip_midi.exists()
    groups = parse_midi_to_note_groups(roundtrip_midi)
    assert len([g for g in groups if g["type"] != "rest"]) >= 1
    print(f"[OK] Converted MP3 -> MIDI: {len(groups)} note groups")

    source_midi.unlink(missing_ok=True)
    mp3_out.unlink(missing_ok=True)
    roundtrip_midi.unlink(missing_ok=True)


async def test_api_conversion_and_edit():
    midi_path = create_test_midi(Path("data/test_api_conversion.mid"))
    mp3_path = Path("data/test_api_conversion.mp3")
    convert_midi_to_mp3(midi_path, mp3_path)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/api/projects", json={"title": "Conversion Edit Test", "instrument": "violin"})
        assert r.status_code == 200
        pid = r.json()["id"]

        files = {"file": ("melody.mp3", BytesIO(mp3_path.read_bytes()), "audio/mpeg")}
        r = await client.post(f"/api/projects/{pid}/score-file", files=files)
        assert r.status_code == 200
        print(f"[OK] Uploaded MP3 as score source: {r.json()['file_id']}")

        r = await client.post(f"/api/projects/{pid}/parse-score")
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "mp3"
        print(f"[OK] Parsed MP3 score source: {r.json()['note_groups_count']} groups")

        r = await client.post(f"/api/projects/{pid}/convert?target=mp3")
        assert r.status_code == 200, r.text
        conversion = r.json()
        assert conversion["mp3_url"]
        assert conversion["midi_url"]
        print("[OK] API conversion returned MIDI and MP3 URLs")

        r = await client.get(f"/api/projects/{pid}/score")
        assert r.status_code == 200
        score = r.json()
        assert score["note_groups"]

        edited = score["note_groups"]
        edited[0]["target_pitches"] = [72]
        edited[0]["target_names"] = ["C5"]
        edited[0]["type"] = "single_note"

        r = await client.put(f"/api/projects/{pid}/score", json={"note_groups": edited})
        assert r.status_code == 200, r.text
        updated = r.json()
        assert updated["note_groups"][0]["target_pitches"] == [72]
        assert updated["musicxml_url"]
        assert updated["midi_url"]
        print("[OK] Edited score persisted and regenerated exports")

    midi_path.unlink(missing_ok=True)
    mp3_path.unlink(missing_ok=True)


if __name__ == "__main__":
    test_conversion_services()
    asyncio.run(test_api_conversion_and_edit())
    print("\n=== CONVERSION AND SCORE EDIT TEST PASSED ===")
