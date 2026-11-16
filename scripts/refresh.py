#!/usr/bin/env python3
"""One headless Claude/Copilot quota pass; no auth refresh or forced probes."""

import copy
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any

MAX_BYTES = 256 * 1024
TIMEOUT = 45


def log(provider: str, message: str) -> None:
    print(f"herdr-fleet-quota-refresh: {provider}: {message}", flush=True)


def directory(path: Path) -> None:
    for node in reversed((path, *path.parents)):
        try:
            node.mkdir(mode=0o700)
        except FileExistsError:
            pass
        if not stat.S_ISDIR(node.lstat().st_mode):
            raise OSError("unsafe directory")


def regular(path: Path) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISREG(mode):
        raise OSError("unsafe file")


def reject_constant(value: str) -> None:
    raise ValueError("non-JSON constant")


def decode(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_BYTES:
        raise ValueError("oversized record")
    value = json.loads(raw, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("not an object")
    return value


def read(path: Path) -> dict[str, Any]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise OSError("unsafe file")
        return decode(source.read(MAX_BYTES + 1))


def atomic(path: Path, value: dict[str, Any]) -> None:
    regular(path)
    raw = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
    if len(raw) > MAX_BYTES:
        raise ValueError("oversized result")
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        regular(path)
        os.replace(name, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        Path(name).unlink(missing_ok=True)


def stamp(value: Any) -> int:
    return value if type(value) is int and 0 < value < 10**15 else 0


def valid_record(record: dict[str, Any], provider: str) -> bool:
    return (record.get("id") == provider
            and isinstance(record.get("limits", []), list)
            and isinstance(record.get("accounts", []), list)
            and all(isinstance(a, dict) and isinstance(a.get("limits", []), list)
                    for a in record.get("accounts", [])))


def usable_quota(record: dict[str, Any]) -> bool:
    def amount(value: Any) -> bool:
        return type(value) in (int, float) and 0 <= value <= sys.float_info.max

    balance = record.get("balance")
    return (any(isinstance(window, dict) and window.get("invalid") is not True
                and amount(window.get("percent")) for window in record.get("limits", []))
            or isinstance(balance, dict) and balance.get("invalid") is not True
            and amount(balance.get("remaining")))


def fresh(new: dict[str, Any], old: dict[str, Any], field: str, stale: str,
          started_ms: int, observed_ms: int) -> bool:
    fetched = stamp(new.get(field))
    # Cached windows may have been auto-opened to zero after reset. Only a
    # measurement stamped during this invocation can replace historical quota.
    return (started_ms <= fetched <= observed_ms and fetched > stamp(old.get(field))
            and new.get(stale) is not True and usable_quota(new))


def stale_record(record: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(record)
    result["limitsStale"] = True
    for account in result.get("accounts", []):
        if isinstance(account, dict):
            account["stale"] = True
    return result


def merge(new: dict[str, Any], old: dict[str, Any], started_ms: int,
          observed_ms: int) -> tuple[dict[str, Any], bool]:
    root_fresh = fresh(new, old, "limitsFetchedAt", "limitsStale", started_ms, observed_ms)
    result = copy.deepcopy(new if root_fresh else (old or new))
    result["limitsStale"] = not root_fresh
    accounts = new.get("accounts")
    previous = old.get("accounts", [])
    if not accounts and previous:
        return stale_record(old), False
    if not accounts:
        return result, root_fresh
    if not isinstance(accounts, list) or not all(isinstance(a, dict) for a in accounts):
        return stale_record(old or {"id": new["id"], "limits": []}), False
    previous = previous if isinstance(previous, list) else []

    def identities(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        ids = [a.get("id") for a in rows if isinstance(a, dict)]
        return {a["id"]: a for a in rows if isinstance(a, dict)
                and isinstance(a.get("id"), str) and a["id"]
                and ids.count(a["id"]) == 1}

    before, incoming = identities(previous), identities(accounts)
    if len(incoming) != len(accounts) or len(before) != len(previous):
        return stale_record(old or new), False
    merged = []
    all_fresh = True
    for account in accounts:
        identity = account.get("id")
        known = isinstance(identity, str) and identity in incoming
        saved = before.get(identity, {}) if known else {}
        ok = known and fresh(account, saved, "fetchedAt", "stale", started_ms, observed_ms)
        row = copy.deepcopy(account if ok else (saved or account))
        # Activity is current metadata, not evidence that old quota is fresh.
        row["active"] = account.get("active") is True
        row["stale"] = not ok
        merged.append(row)
        all_fresh = all_fresh and ok
    for identity, account in before.items():
        if identity not in incoming:
            row = copy.deepcopy(account)
            row.update(stale=True, active=False)
            merged.append(row)
            all_fresh = False
    result["accounts"] = merged
    return result, all_fresh


def collect(executable: Path, environment: dict[str, str], provider: str) -> dict[str, Any]:
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen([str(executable), "--limits-only"], env=environment,
                                   stdin=subprocess.DEVNULL, stdout=output,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            code = process.wait(timeout=TIMEOUT)
            if code:
                log(provider, f"collector failed (exit {code})")
                raise ValueError("collector failure")
            output.seek(0)
            record = decode(output.read(MAX_BYTES + 1))
            if not valid_record(record, provider):
                raise ValueError("wrong provider")
            return record
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def refresh(provider: str, usage: Path, control: Path, environment: dict[str, str]) -> bool:
    destination = usage / f"{provider}.json"
    state_path = control / f"{provider}.state"
    old: dict[str, Any] = {}
    try:
        regular(destination)
        try:
            old = read(destination)
            if not valid_record(old, provider):
                old = {}
        except (FileNotFoundError, ValueError, RecursionError):
            pass
        regular(state_path)
        try:
            state = read(state_path)
        except FileNotFoundError:
            state = {"failures": 0, "next": 0}
        failures, next_attempt = state.get("failures"), state.get("next")
        if (type(failures) is not int or not 0 <= failures <= 5
                or type(next_attempt) is not int or not 0 <= next_attempt <= int(time.time()) + 900):
            raise ValueError("invalid control state")
        if time.time() < next_attempt:
            log(provider, "retry deferred (persisted backoff)")
            return True
        delay = min(60 * 2**failures, 900)
        reservation = {"failures": min(failures + 1, 5), "next": int(time.time()) + delay}
        # Fail closed: no remote call until the next attempt is durably reserved.
        atomic(state_path, reservation)
    except (OSError, ValueError, RecursionError):
        log(provider, "unsafe record or control state unavailable; no collector called")
        return False

    try:
        try:
            started_ms = time.time_ns() // 1_000_000
            new = collect(Path(environment["OMARCHY_PATH"]) / "bin" /
                          f"omarchy-agent-usage-{provider}", environment, provider)
            observed_ms = time.time_ns() // 1_000_000
            record, success = merge(new, old, started_ms, observed_ms)
        except (OSError, ValueError, RecursionError, subprocess.TimeoutExpired):
            log(provider, "collector unavailable, timed out, or invalid; retaining prior quota")
            record = stale_record(old or {"id": provider, "limits": [], "limitsFetchedAt": 0})
            success = False
        atomic(destination, record)
        if success:
            atomic(state_path, {"failures": 0, "next": int(time.time()) + 60})
            log(provider, "fresh quota published")
        else:
            log(provider, f"stale/unknown quota published; retry deferred {delay}s")
        return success
    except (OSError, ValueError, RecursionError):
        log(provider, "record/control write failed; reserved retry remains in effect")
        return False


def interrupted(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt


def main() -> int:
    providers = sys.argv[1:] or ["claude", "copilot"]
    if any(p not in ("claude", "copilot") for p in providers):
        log("arguments", "only claude and copilot are supported")
        return 2
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    environment = dict(os.environ)
    environment["OMARCHY_PATH"] = environment.get("OMARCHY_PATH") or "/usr/share/omarchy"
    state = Path(environment.get("XDG_STATE_HOME") or str(Path.home() / ".local/state"))
    if not state.is_absolute():
        log("state", "absolute state path required")
        return 2
    usage, control = state / "omarchy/agents/usage", state / "herdr-fleet-quota"
    try:
        directory(usage)
        directory(control)
        lock_path = control / "refresh.lock"
        regular(lock_path)
        with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600), "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log("lock", "another refresh is running; skipping")
                return 0
            results = [refresh(p, usage, control, environment) for p in dict.fromkeys(providers)]
            return 0 if all(results) else 1
    except (OSError, ValueError):
        log("state", "state directory or lock unavailable")
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
