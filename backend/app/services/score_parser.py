"""ScoreService: MusicXML/MIDI parsing and export using music21."""
from pathlib import Path
from typing import Union
import xml.etree.ElementTree as ET

from music21 import chord, converter, duration, expressions, instrument, key, metadata, meter, note, pitch, stream


def _parse_score_object_to_note_groups(score, bpm: float = 120.0) -> list[dict]:
    """Extract note_groups from a music21 Score object.

    Each note_group has:
      - measure, beat, start (seconds), end (seconds)
      - target_pitches (MIDI numbers as list), target_names (note names as list)
      - type: single_note | double_stop | chord | rest
    """
    part = score.parts[0] if score.parts else score

    beat_duration = 60.0 / bpm
    groups: list[dict] = []

    for measure in part.getElementsByClass(stream.Measure):
        measure_number = measure.number
        for element in measure.notesAndRests:
            beat_offset = float(element.offset) + 1.0
            quarter_length = float(element.quarterLength)
            start_time = (float(element.getOffsetInHierarchy(part))) * beat_duration
            end_time = start_time + quarter_length * beat_duration

            if isinstance(element, chord.Chord):
                pitches = [p.midi for p in element.pitches]
                names = [p.nameWithOctave for p in element.pitches]
                note_type = "double_stop" if len(pitches) == 2 else "chord"
            elif isinstance(element, note.Note):
                pitches = [element.pitch.midi]
                names = [element.pitch.nameWithOctave]
                note_type = "single_note"
            elif isinstance(element, note.Rest):
                pitches = []
                names = []
                note_type = "rest"
            else:
                continue

            groups.append({
                "measure": measure_number,
                "beat": beat_offset,
                "start": round(start_time, 4),
                "end": round(end_time, 4),
                "target_pitches": pitches,
                "target_names": names,
                "type": note_type,
            })

    return groups


def parse_musicxml_to_note_groups(musicxml_path: Union[str, Path], bpm: float = 120.0) -> list[dict]:
    """Parse a MusicXML file into note_groups."""
    score = converter.parse(str(musicxml_path))
    return _parse_score_object_to_note_groups(score, bpm)


def parse_midi_to_note_groups(midi_path: Union[str, Path], bpm: float = 120.0) -> list[dict]:
    """Parse a MIDI file into note_groups."""
    score = converter.parse(str(midi_path))
    return _parse_score_object_to_note_groups(score, bpm)


def _midi_name(midi_value: int) -> str:
    p = pitch.Pitch()
    p.midi = midi_value
    return p.nameWithOctave


def _xml_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child_text(element: ET.Element, child_name: str) -> str | None:
    for child in element:
        if _xml_name(child.tag) == child_name and child.text:
            return child.text.strip()
    return None


def extract_musicxml_metadata(musicxml_path: Union[str, Path]) -> dict:
    """Extract notation metadata that note_groups cannot represent."""
    defaults = {
        "key_fifths": 0,
        "key_mode": "major",
        "time_signature": "4/4",
        "tempo": 120.0,
    }
    path = Path(musicxml_path)
    if not path.exists():
        return defaults

    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return defaults

    data = dict(defaults)
    found_key = False
    found_time = False
    found_tempo = False

    for element in root.iter():
        name = _xml_name(element.tag)
        if name == "key" and not found_key:
            fifths = _child_text(element, "fifths")
            mode = _child_text(element, "mode")
            if fifths is not None:
                try:
                    data["key_fifths"] = int(fifths)
                except ValueError:
                    pass
            if mode:
                data["key_mode"] = mode
            found_key = True
        elif name == "time" and not found_time:
            beats = _child_text(element, "beats")
            beat_type = _child_text(element, "beat-type")
            if beats and beat_type:
                data["time_signature"] = f"{beats}/{beat_type}"
            found_time = True
        elif name == "sound" and not found_tempo:
            tempo_value = element.attrib.get("tempo")
            if tempo_value:
                try:
                    data["tempo"] = float(tempo_value)
                    found_tempo = True
                except ValueError:
                    pass
        elif name == "per-minute" and not found_tempo and element.text:
            try:
                data["tempo"] = float(element.text.strip())
                found_tempo = True
            except ValueError:
                pass

    return data


def _duration_to_quarter_length(start: float, end: float, bpm: float) -> float:
    beat_duration = 60.0 / bpm
    duration_seconds = max(0.05, float(end) - float(start))
    quarter_length = duration_seconds / beat_duration
    return max(0.125, round(quarter_length * 24) / 24)


def _bounded_beat(beat: float) -> float:
    return max(1.0, min(4.958, round(float(beat) * 24) / 24))


def _split_note_type(note_type: str) -> tuple[str, set[str]]:
    parts = str(note_type or "").split(":")
    base = parts[0] if parts[0] in {"single_note", "double_stop", "chord", "rest"} else "single_note"
    modifiers = {item for part in parts[1:] for item in part.split(",") if item}
    return base, modifiers


def _compose_note_type(base: str, modifiers: set[str]) -> str:
    if not modifiers:
        return base
    return f"{base}:{','.join(sorted(modifiers))}"


def _make_music21_element(group: dict, quarter_length: float):
    pitches = [int(p) for p in group.get("target_pitches", []) if p is not None]
    note_type, modifiers = _split_note_type(group.get("type") or ("rest" if not pitches else "single_note"))

    if note_type == "rest" or not pitches:
        element = note.Rest(quarterLength=quarter_length)
    elif len(pitches) == 1:
        element = note.Note(quarterLength=quarter_length)
        element.pitch.midi = pitches[0]
    else:
        element = chord.Chord(pitches, quarterLength=quarter_length)

    if "dotted" in modifiers:
        element.duration.dots = 1
    if "tuplet3" in modifiers:
        try:
            element.duration.appendTuplet(duration.Tuplet(3, 2))
        except Exception:
            pass
    if "grace" in modifiers and not isinstance(element, note.Rest):
        try:
            element = element.getGrace()
        except Exception:
            element.duration.quarterLength = 0.125
    if "trill" in modifiers and not isinstance(element, note.Rest):
        element.expressions.append(expressions.Trill())
    if "turn" in modifiers and not isinstance(element, note.Rest):
        element.expressions.append(expressions.Turn())
    if "fermata" in modifiers:
        element.expressions.append(expressions.Fermata())
    return element


def _instrument_for_name(instrument_name: str):
    instrument_map = {
        "violin": instrument.Violin,
        "piano": instrument.Piano,
        "flute": instrument.Flute,
        "guitar": instrument.Guitar,
        "cello": instrument.Violoncello,
        "clarinet": instrument.Clarinet,
    }
    instrument_class = instrument_map.get(instrument_name.lower())
    if instrument_class:
        return instrument_class()
    generic = instrument.Instrument()
    generic.instrumentName = instrument_name
    return generic


def build_score_from_note_groups(
    note_groups: list[dict],
    bpm: float = 120.0,
    title: str = "ScoreDiff Edited Score",
    instrument_name: str = "violin",
    key_fifths: int = 0,
    time_signature: str = "4/4",
):
    """Build a music21 score from editable note_group dictionaries."""
    score = stream.Score()
    score.metadata = metadata.Metadata()
    score.metadata.title = title

    part = stream.Part()
    part.insert(0, _instrument_for_name(instrument_name))

    grouped: dict[int, list[dict]] = {}
    for group in note_groups:
        measure_no = int(group.get("measure") or 1)
        grouped.setdefault(measure_no, []).append(group)

    for measure_no in sorted(grouped):
        measure = stream.Measure(number=measure_no)
        if measure_no == 1:
            measure.append(key.KeySignature(int(key_fifths or 0)))
            measure.append(meter.TimeSignature(time_signature or "4/4"))

        cadenza_measure = any("cadenza" in _split_note_type(group.get("type", ""))[1] for group in grouped[measure_no])
        cursor = 0.0
        for group in sorted(grouped[measure_no], key=lambda g: (float(g.get("beat") or 1), float(g.get("start") or 0))):
            start = float(group.get("start") or 0)
            end = float(group.get("end") or (start + 0.5))
            offset = _bounded_beat(float(group.get("beat") or 1)) - 1.0
            if offset < cursor:
                offset = cursor
            if offset >= 4.0:
                continue

            if offset > cursor:
                measure.append(note.Rest(quarterLength=round(offset - cursor, 4)))
                cursor = offset

            quarter_length = _duration_to_quarter_length(start, end, bpm)
            if not cadenza_measure:
                quarter_length = min(quarter_length, 4.0 - cursor)
            if quarter_length <= 0:
                continue

            measure.append(_make_music21_element(group, quarter_length))
            cursor = round(cursor + quarter_length, 4)

        if cursor < 4.0 and not cadenza_measure:
            measure.append(note.Rest(quarterLength=round(4.0 - cursor, 4)))

        part.append(measure)

    score.append(part)
    return score


def export_note_groups_to_musicxml(
    note_groups: list[dict],
    output_path: Union[str, Path],
    bpm: float = 120.0,
    title: str = "ScoreDiff Edited Score",
    instrument_name: str = "violin",
    key_fifths: int | None = None,
    time_signature: str | None = None,
):
    """Export editable note_groups to a MusicXML file."""
    output = Path(output_path)
    if output.exists() and (key_fifths is None or time_signature is None):
        existing_metadata = extract_musicxml_metadata(output)
        if key_fifths is None:
            key_fifths = int(existing_metadata["key_fifths"])
        if time_signature is None:
            time_signature = str(existing_metadata["time_signature"])

    score = build_score_from_note_groups(
        note_groups,
        bpm=bpm,
        title=title,
        instrument_name=instrument_name,
        key_fifths=key_fifths or 0,
        time_signature=time_signature or "4/4",
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(output))
    return output_path


def normalize_note_group(group: dict, bpm: float = 120.0) -> dict:
    """Return a safe note_group payload for persistence and score export."""
    beat_duration = 60.0 / bpm
    measure = max(1, int(group.get("measure") or 1))
    beat = _bounded_beat(float(group.get("beat") or 1.0))
    start = ((measure - 1) * 4 + (beat - 1)) * beat_duration
    end = float(group.get("end") or (start + beat_duration))
    if end <= start:
        end = start + beat_duration
    measure_end = ((measure - 1) * 4 + 4) * beat_duration
    end = min(end, measure_end)
    if end <= start:
        end = min(start + (0.125 * beat_duration), measure_end)

    pitches = [int(p) for p in group.get("target_pitches", []) if p is not None]
    names = group.get("target_names") or [_midi_name(p) for p in pitches]
    if len(names) != len(pitches):
        names = [_midi_name(p) for p in pitches]

    if not pitches:
        base_type = "rest"
    elif len(pitches) == 1:
        base_type = "single_note"
    elif len(pitches) == 2:
        base_type = "double_stop"
    else:
        base_type = "chord"
    _, modifiers = _split_note_type(group.get("type") or base_type)

    return {
        "measure": measure,
        "beat": round(beat, 3),
        "start": round(start, 4),
        "end": round(end, 4),
        "target_pitches": pitches,
        "target_names": names,
        "type": _compose_note_type(base_type, modifiers),
    }


def generate_midi_from_musicxml(musicxml_path: Union[str, Path], output_path: Union[str, Path]):
    """Convert MusicXML to MIDI file."""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    score = converter.parse(str(musicxml_path))
    score.write("midi", fp=str(output_path))
    return output_path


def convert_midi_to_musicxml(midi_path: Union[str, Path], output_path: Union[str, Path]):
    """Convert MIDI to MusicXML file."""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    score = converter.parse(str(midi_path))
    score.write("musicxml", fp=str(output_path))
    return output_path
