#!/usr/bin/env python3
"""Run Duo gates and capture the open display through Device Hub."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import threading

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / '.agent-bus-out/12274'
SPEC = importlib.util.spec_from_file_location('aurora_drill', Path(__file__).with_name('run-aurora-drill.py'))
drill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(drill)
drill.OUT = OUT
OPEN_DISPLAY = '--open-display' in sys.argv
CLOSED_DISPLAY = '--closed-display' in sys.argv
SEED_PHOTO = '--seed-photo' in sys.argv
SKIP_CAPTURES = '--skip-captures' in sys.argv
for flag in ['--open-display', '--closed-display', '--seed-photo', '--skip-captures']:
    if flag in sys.argv:
        sys.argv.remove(flag)


def control(button, expected_help):
    script = f'''with timeout of 10 seconds
 tell application "System Events" to tell process "DeviceHub"
  if name of window 1 does not contain "Trantor Duo 13" then error "Select Trantor Duo 13 in Device Hub"
  set controls to group 3 of splitter group 1 of group 1 of splitter group 1 of group 1 of window 1
  if help of button {button} of controls is not "{expected_help}" then error "Device Hub control changed"
  click button {button} of controls
 end tell
end timeout'''
    subprocess.run(['osascript', '-e', script], cwd=ROOT, check=True, capture_output=True, text=True)


def watch_output(log_path, device, stop, errors):
    opened = False
    cursor = 0
    try:
        while not stop.is_set():
            if not opened:
                devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '--json']))
                owned = next(d for group in devices['devices'].values() for d in group if d['udid'] == device)
                if owned['name'] != 'Trantor Duo 13':
                    raise RuntimeError('The Duo drill requires the owned Trantor Duo 13 simulator')
                if owned['state'] == 'Booted':
                    subprocess.run(['xcrun', 'simctl', 'bootstatus', device, '-b'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
                    if OPEN_DISPLAY:
                        control(7, 'Open')
                    elif CLOSED_DISPLAY:
                        control(5, 'Closed')
                    if SEED_PHOTO:
                        photo = ROOT / 'ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png'
                        subprocess.run(['xcrun', 'simctl', 'addmedia', device, str(photo)], cwd=ROOT, check=True)
                    opened = True
            with log_path.open() as source:
                source.seek(cursor)
                lines = source.readlines()
                cursor = source.tell()
            for line in lines:
                if line.strip() == 'DUO_ROTATE':
                    control(4, 'Rotate Right')
                match = re.fullmatch(r'DUO_CAPTURE ([a-z-]+)\n', line)
                if match:
                    if not SKIP_CAPTURES:
                        target = OUT / (match[1] + '.png')
                        subprocess.run(['xcrun', 'simctl', 'io', device, 'screenshot', '--display=primary-1', str(target)], cwd=ROOT, check=True)
                    container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', device,
                                                         'ai.trantor.aurorauitests.xctrunner', 'data'], text=True).strip()
                    (Path(container) / 'tmp' / ('duo-captured-' + match[1])).touch()
            stop.wait(0.2 if opened else 1)
    except Exception as error:
        errors.append(str(error))


original_run = drill.run_monitored


def run_monitored(command, device, log):
    command = command + ['-sdk', 'iphonesimulator27.1']
    stop = threading.Event()
    errors = []
    watcher = None
    if OPEN_DISPLAY or CLOSED_DISPLAY or SEED_PHOTO:
        watcher = threading.Thread(target=watch_output, args=(Path(log.name), device, stop, errors), daemon=True)
        watcher.start()
    try:
        result = original_run(command, device, log)
    finally:
        stop.set()
        if watcher:
            watcher.join(timeout=15)
    for error in errors:
        print('Duo capture failed: ' + error, file=sys.stderr)
    return result or (1 if errors else 0)


drill.run_monitored = run_monitored
if __name__ == '__main__':
    sys.exit(drill.main())
