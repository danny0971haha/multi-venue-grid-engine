import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "offline-candidate.py"
spec = importlib.util.spec_from_file_location("candidate", SOURCE)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateValidationTests(unittest.TestCase):
    def test_missing_tap_total_rejected(self):
        with self.assertRaises(RuntimeError):
            candidate.tap_counts("# tests 474\n# pass 474\n")

    def test_duplicate_tap_total_rejected(self):
        with self.assertRaises(RuntimeError):
            candidate.tap_counts("# tests 474\n# tests 1\n")

    def test_tap_counts_preserve_failure_skip_and_todo(self):
        output = "# tests 79\n# pass 76\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1\n"
        self.assertEqual(candidate.tap_counts(output), {
            "tests": 79, "pass": 76, "fail": 1, "cancelled": 0, "skipped": 1, "todo": 1})

    def test_real_command_failure_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            code = candidate.execute([sys.executable, "-c", "raise SystemExit(9)"],
                                     {"PATH": os.environ["PATH"]}, Path(temporary) / "log")
            self.assertEqual(code, 9)

    def test_descendant_cannot_open_network_socket(self):
        program = f'''import runpy,subprocess,sys
runpy.run_path({str(SOURCE)!r})['isolate']()
code="import socket; socket.socket(socket.AF_INET6, socket.SOCK_STREAM)"
child=subprocess.run([sys.executable,'-c',code],capture_output=True)
assert child.returncode != 0 and b'Operation not permitted' in child.stderr
'''
        result = subprocess.run([sys.executable, "-c", program], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())


if __name__ == "__main__":
    unittest.main()
