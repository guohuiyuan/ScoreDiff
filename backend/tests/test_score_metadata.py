"""Regression tests for MusicXML metadata preserved by score edits."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.score_parser import export_note_groups_to_musicxml, extract_musicxml_metadata


def test_score_export_preserves_existing_key_signature():
    path = Path("data/test_key_preserve.musicxml")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>-1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>
""",
        encoding="utf-8",
    )

    try:
        assert extract_musicxml_metadata(path)["key_fifths"] == -1

        export_note_groups_to_musicxml(
            [
                {
                    "note_group_id": "ng_flat",
                    "measure": 1,
                    "beat": 1,
                    "start": 0,
                    "end": 0.5,
                    "target_pitches": [70],
                    "target_names": ["B-4"],
                    "type": "single_note",
                }
            ],
            path,
        )

        assert extract_musicxml_metadata(path)["key_fifths"] == -1
        print("[OK] Edited score export preserves existing key signature")
    finally:
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    test_score_export_preserves_existing_key_signature()
