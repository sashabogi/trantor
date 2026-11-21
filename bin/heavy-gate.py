#!/usr/bin/env python3
import fcntl
import json
import os
from pathlib import Path
import sys
import time
import uuid


def bus_dir():
    return Path(os.environ.get("AGENT_BUS_DIR") or os.environ.get("RELAY_DATA_DIR") or (Path.home() / ".agent-bus"))


def slot_count():
    try:
        value = json.loads((bus_dir() / "config.json").read_text()).get("heavyGateSlots")
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    except (OSError, ValueError, TypeError):
        pass
    return max(1, (os.cpu_count() or 1) // 4)


wait_dir = os.environ.get("TRANTOR_HEAVY_GATE_WAIT_DIR", "")
wait_file = Path(wait_dir) / f"{os.getpid()}-{uuid.uuid4().hex}.json" if wait_dir else None
wait_started = None


def write_wait(waiting):
    if not wait_file or wait_started is None:
        return
    now = int(time.time() * 1000)
    record = {
        "pid": os.getpid(),
        "waiting": waiting,
        "updatedAt": now,
        "totalMs": int((time.monotonic() - wait_started) * 1000),
    }
    wait_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = wait_file.with_suffix(".tmp")
    temporary.write_text(json.dumps(record))
    os.replace(temporary, wait_file)


def acquire(slots):
    global wait_started
    lock_dir = bus_dir() / "heavy-gate"
    lock_dir.mkdir(parents=True, exist_ok=True)
    announced = False
    last_beat = 0.0
    while True:
        in_use = 0
        for index in range(slots):
            handle = (lock_dir / f"slot-{index}.lock").open("a+")
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                in_use += 1
                handle.close()
                continue
            handle.seek(0)
            handle.truncate()
            handle.write(f"{os.getpid()}\n")
            handle.flush()
            os.set_inheritable(handle.fileno(), True)
            write_wait(False)
            return handle
        if not announced:
            wait_started = time.monotonic()
            print(f"waiting for a heavy-gate slot ({in_use} in use)", flush=True)
            announced = True
        now = time.monotonic()
        if now - last_beat >= 1:
            write_wait(True)
            last_beat = now
        time.sleep(0.1)


def main():
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("usage: heavy-gate.py -- <command> [args ...]", file=sys.stderr)
        return 2
    env = os.environ.copy()
    if env.get("TRANTOR_HEAVY_GATE_HELD") != "1":
        lock = acquire(slot_count())
        env["TRANTOR_HEAVY_GATE_HELD"] = "1"
        os.set_inheritable(lock.fileno(), True)
    os.execvpe(args[0], args, env)


if __name__ == "__main__":
    raise SystemExit(main())
