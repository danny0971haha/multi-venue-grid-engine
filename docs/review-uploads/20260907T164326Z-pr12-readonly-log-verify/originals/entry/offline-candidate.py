"""Isolated developer evidence. No runtime/governance authority is created."""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
COMMANDS = [
    ["npm", "ci"], ["npm", "run", "typecheck"], ["npm", "run", "lint"],
    ["npm", "run", "format:check"], ["npm", "test"],
    ["npm", "run", "test:phase2e"], ["npm", "run", "build"],
    ["npm", "run", "scan:secrets"], ["npm", "run", "dry-run"],
]


def isolate():
    class Argument(ctypes.Structure):
        _fields_ = [("index", ctypes.c_uint), ("comparison", ctypes.c_int),
                    ("value", ctypes.c_uint64), ("unused", ctypes.c_uint64)]
    api = ctypes.CDLL("libseccomp.so.2")
    api.seccomp_init.argtypes = [ctypes.c_uint32]
    api.seccomp_init.restype = ctypes.c_void_p
    api.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    api.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                    ctypes.c_int, ctypes.c_uint]
    api.seccomp_load.argtypes = [ctypes.c_void_p]
    api.seccomp_release.argtypes = [ctypes.c_void_p]
    policy = api.seccomp_init(0x7FFF0000)
    if not policy:
        raise RuntimeError("OFFLINE_ISOLATION_UNAVAILABLE")
    try:
        for call in [b"socket", b"socketpair"]:
            number = api.seccomp_syscall_resolve_name(call)
            result = api.seccomp_rule_add(policy, 0x50000 | errno.EPERM, number, 1,
                                          Argument(0, 1, 1, 0))
            if number < 0 or result != 0:
                raise RuntimeError("OFFLINE_FILTER_FAILED")
        if api.seccomp_load(policy):
            raise RuntimeError("OFFLINE_ISOLATION_UNAVAILABLE")
    finally:
        api.seccomp_release(policy)


def tap_counts(output):
    result = {}
    for key in ["tests", "pass", "fail", "cancelled", "skipped", "todo"]:
        values = re.findall(r"^# " + key + r" (\d+)\s*$", output, re.MULTILINE)
        if len(values) != 1:
            raise RuntimeError("TAP_TOTAL_MISSING_OR_AMBIGUOUS:" + key)
        result[key] = int(values[0])
    return result


def execute(command, env, log):
    with log.open("wb") as stream:
        try:
            child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stream,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            try:
                return child.wait(timeout=600)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                return 124
        except OSError as error:
            stream.write((type(error).__name__ + "\n").encode())
            return 127


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["validate", "simulate", "test"])
    parser.add_argument("--cache", type=Path, help="Trusted prepopulated offline npm cache")
    args = parser.parse_args()
    mode = args.mode
    report = {"repository": "multi-venue-grid-engine", "mode": mode,
              "liveExchangeWrites": False, "networkAccessRequired": False,
              "authorizationGranted": False, "validationCompleted": False,
              "checks": [], "blockers": []}
    try:
        if mode not in ["validate", "simulate", "test"]:
            raise RuntimeError("EXPECTED_VALIDATE_SIMULATE_OR_TEST")
        isolate()
        report["networkIsolation"] = "LINUX_SECCOMP_UNIX_SOCKETS_ONLY"
        if any(p.name != ".env.example" for p in ROOT.glob(".env*")):
            raise RuntimeError("ENV_FILE_PRESENT_USE_CREDENTIAL_FREE_CHECKOUT")
        with tempfile.TemporaryDirectory(prefix="multi-offline-home-") as home:
            env = {"PATH": os.environ["PATH"], "HOME": home, "TMPDIR": home,
                   "GIT_NO_LAZY_FETCH": "1", "npm_config_offline": "true",
                   "npm_config_audit": "false", "npm_config_fund": "false",
                   "npm_config_update_notifier": "false", "npm_config_fetch_retries": "0"}
            if args.cache is not None:
                if not args.cache.is_dir():
                    raise RuntimeError("OFFLINE_CACHE_DIRECTORY_MISSING")
                env["npm_config_cache"] = str(args.cache.resolve())
            for key, git_args in [("candidate", ["rev-parse", "HEAD"]),
                              ("candidateTree", ["rev-parse", "HEAD^{tree}"]),
                              ("workingTreeStatus", ["status", "--porcelain", "--untracked-files=all"])]:
                report[key] = subprocess.check_output(["git", *git_args], cwd=ROOT,
                                                       env=env, text=True).strip()
            frozen = "7f196d367e39640eee9517f742b0d61424f9d4cc"
            expected_tree = "1b0afe805269972cf7af40f7fbf0e4e6b3e35894"
            frozen_tree = subprocess.check_output(["git", "rev-parse", frozen + "^{tree}"],
                                                   cwd=ROOT, env=env, text=True).strip()
            if frozen_tree != expected_tree:
                raise RuntimeError("FROZEN_BASELINE_IDENTITY_MISMATCH")
            report["frozenBaselineTree"] = frozen_tree
            logdir = ROOT / "artifacts" / "offline-candidate" / mode
            logdir.mkdir(parents=True, exist_ok=True)
            commands = COMMANDS if mode == "validate" else [
                ["node", "--import", "tsx", "test/offline-integration/run.ts"]
                if mode == "simulate" else
                ["node", "--import", "tsx", "--test", "--test-reporter=tap",
                 "test/offline-integration/integration.test.ts"]]
            for i, command in enumerate(commands):
                log = logdir / f"{i + 1:02}.log"
                code = execute(command, env, log)
                item = {"command": command, "exitCode": code,
                        "log": str(log.relative_to(ROOT)),
                        "logSha256": hashlib.sha256(log.read_bytes()).hexdigest()}
                report["checks"].append(item)
                print(f"{' '.join(command)}: exit {code}", file=sys.stderr)
                if code:
                    raise RuntimeError("MANDATORY_COMMAND_FAILED")
                expected = 13 if mode == "test" else (474 if command == ["npm", "test"] else (
                    79 if command == ["npm", "run", "test:phase2e"] else None))
                if expected is not None:
                    item["tap"] = tap_counts(log.read_text())
                    if item["tap"] != {"tests": expected, "pass": expected, "fail": 0,
                                       "cancelled": 0, "skipped": 0, "todo": 0}:
                        raise RuntimeError("EXACT_HISTORICAL_TEST_TOTAL_MISMATCH")
            if mode == "simulate":
                report["simulation"] = json.loads(log.read_text())
            after_tree = subprocess.check_output(["git", "rev-parse", frozen + "^{tree}"],
                                                  cwd=ROOT, env=env, text=True).strip()
            if after_tree != expected_tree:
                raise RuntimeError("FROZEN_BASELINE_IDENTITY_MISMATCH")
            report["frozenIdentityPreserved"] = True
            report["validationCompleted"] = True
    except Exception as error:
        report["blockers"].append(str(error) if isinstance(error, RuntimeError)
                                  else type(error).__name__)
    print(json.dumps(report, indent=2))
    return 0 if report["validationCompleted"] else 1


if __name__ == "__main__":
    sys.exit(main())
