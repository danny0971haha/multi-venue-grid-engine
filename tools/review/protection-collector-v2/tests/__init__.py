from pathlib import Path
import json

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures"


def load_json(relative: str):
    path = FIXTURE_ROOT / relative
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(relative: str, obj) -> None:
    path = FIXTURE_ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
