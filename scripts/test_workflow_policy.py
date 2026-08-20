#!/usr/bin/env python3
"""Regression tests for immutable, least-privilege GitHub Actions usage."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = (
    ROOT / ".github" / "workflows" / "ci.yml",
    ROOT / ".github" / "workflows" / "release-artifact.yml",
)


class WorkflowPolicyTests(unittest.TestCase):
    def test_actions_are_immutable_and_workflows_are_least_privilege(self) -> None:
        for path in WORKFLOWS:
            with self.subTest(path=path.name):
                text = path.read_text(encoding="utf-8")
                uses = re.findall(r"^\s*-?\s*uses:\s*([^\s#]+)", text, re.MULTILINE)
                self.assertTrue(uses, f"{path} has no actions to validate")
                for action in uses:
                    self.assertRegex(action, r"@[a-f0-9]{40}$")
                self.assertRegex(text, r"(?m)^permissions:\n  contents: read$")
                if "actions/checkout@" in text:
                    self.assertRegex(text, r"(?m)^\s+persist-credentials: false$")

    def test_release_workflow_requires_the_closed_opencode_identity(self) -> None:
        text = WORKFLOWS[1].read_text(encoding="utf-8")
        self.assertIn('"implementation": "approve-bash"', text)
        self.assertIn('"platform": "linux"', text)
        self.assertNotIn('actual["protocol_version"]', text)
        self.assertRegex(text, r"assert actual == \{")


if __name__ == "__main__":
    unittest.main()
