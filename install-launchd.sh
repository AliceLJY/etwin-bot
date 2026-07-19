#!/usr/bin/env bash
# Render path-free launchd templates for the current checkout. Does not load them.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINATION_DIR="${ETWIN_LAUNCHD_DEST_DIR:-$HOME/Library/LaunchAgents}"
mkdir -p "$DESTINATION_DIR"

python3 - "$ROOT" "$HOME" "$DESTINATION_DIR" <<'PY'
from __future__ import annotations

import os
import plistlib
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

root = Path(sys.argv[1])
home = sys.argv[2]
destination_dir = Path(sys.argv[3])
placeholders = {
    "ETWIN_ROOT": str(root),
    "ETWIN_HOME": home,
}


def render(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(
            r"__(ETWIN_ROOT|ETWIN_HOME)__",
            lambda match: placeholders[match.group(1)],
            value,
        )
    if isinstance(value, list):
        return [render(item) for item in value]
    if isinstance(value, dict):
        return {key: render(item) for key, item in value.items()}
    return value


for label in ("com.etwin-bot", "com.etwin-codex-bot"):
    template = root / "deploy" / f"{label}.plist.template"
    destination = destination_dir / f"{label}.plist"
    rendered = render(plistlib.loads(template.read_bytes()))
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination_dir
    )
    try:
        with os.fdopen(fd, "wb") as temporary_file:
            plistlib.dump(rendered, temporary_file, sort_keys=False)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, destination)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    print(f"Rendered {destination}")
PY

if command -v plutil >/dev/null 2>&1; then
  plutil -lint \
    "$DESTINATION_DIR/com.etwin-bot.plist" \
    "$DESTINATION_DIR/com.etwin-codex-bot.plist" >/dev/null
fi
