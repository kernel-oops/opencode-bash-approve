#!/usr/bin/env python3
"""Regression tests for deterministic third-party legal-file discovery."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("generate-third-party-licenses.py")
SPEC = importlib.util.spec_from_file_location("generate_third_party_licenses", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LegalFileDiscoveryTests(unittest.TestCase):
    def test_finds_prefixed_and_non_licence_legal_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "LICENSE",
                "LICENSE-3RD-PARTY.md",
                "SQLITE-LICENSE",
                "NOTICE",
                "PATENTS",
                "CONTRIBUTORS",
                "README.md",
            ):
                (root / name).write_text(name, encoding="utf-8")

            self.assertEqual(
                [path.name for path in MODULE.legal_files(root)],
                [
                    "CONTRIBUTORS",
                    "LICENSE",
                    "LICENSE-3RD-PARTY.md",
                    "NOTICE",
                    "PATENTS",
                    "SQLITE-LICENSE",
                ],
            )


if __name__ == "__main__":
    unittest.main()
