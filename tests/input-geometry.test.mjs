import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checks = String.raw`
import ctypes, importlib.util, sys, unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('phremote_linux_geometry', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)  # No main(), display connection, or XTest calls.

def monitor(x=0, y=0, width=1920, height=1080, primary=False, outputs=None):
    return dict(x=x, y=y, width=width, height=height, primary=primary, outputs=outputs or [])

class GeometryTests(unittest.TestCase):
    def test_primary_output_uses_its_offset_and_edges(self):
        displays = [monitor(outputs=[10]), monitor(x=1920, outputs=[20])]
        geometry = helper.select_primary_geometry(displays, 20, 3840, 1080)
        self.assertEqual(helper.primary_point(geometry, 0, 0), (1920, 0))
        self.assertEqual(helper.primary_point(geometry, 1, 1), (3839, 1079))
        self.assertEqual(helper.primary_point(geometry, .5, .5), (2880, 540))

    def test_primary_monitor_flag_selects_vertical_offset(self):
        displays = [monitor(), monitor(y=1080, primary=True)]
        geometry = helper.select_primary_geometry(displays, 0, 1920, 2160)
        self.assertEqual(helper.primary_point(geometry, 0, 0), (0, 1080))
        self.assertEqual(helper.primary_point(geometry, 1, 1), (1919, 2159))

    def test_confirmed_single_monitor_does_not_expand_to_root(self):
        geometry = helper.select_primary_geometry([monitor(x=500)], 0, 2420, 1080)
        self.assertEqual(helper.primary_point(geometry, 0, 0), (500, 0))
        self.assertEqual(helper.primary_point(geometry, 1, 1), (2419, 1079))

    def test_multiple_unmarked_monitors_are_view_only(self):
        with self.assertRaisesRegex(RuntimeError, 'unique primary'):
            helper.select_primary_geometry([monitor(), monitor(x=1920)], 0, 3840, 1080)

    def test_contradictory_output_and_monitor_primary_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'ambiguous primary'):
            helper.select_primary_geometry([monitor(primary=True, outputs=[10]), monitor(x=1920, outputs=[20])], 20, 3840, 1080)

    def test_absent_monitors_do_not_fall_back_to_root(self):
        with self.assertRaisesRegex(RuntimeError, 'view-only'):
            helper.select_primary_geometry([], 0, 3840, 1080)

    def test_outside_root_geometry_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'outside'):
            helper.select_primary_geometry([monitor(x=3000)], 0, 3840, 1080)

    def test_missing_randr_does_not_guess_a_single_monitor(self):
        with patch.object(helper.ctypes.util, 'find_library', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'libXrandr'):
                helper.read_primary_geometry(object(), None, 0)

    def test_old_randr_is_rejected_before_reading_a_desktop(self):
        def version(_display, major, minor):
            ctypes.cast(major, ctypes.POINTER(ctypes.c_int))[0] = 1
            ctypes.cast(minor, ctypes.POINTER(ctypes.c_int))[0] = 4
            return 1
        library = SimpleNamespace(XRRQueryVersion=version, XRRGetOutputPrimary=lambda *_: 0,
                                  XRRGetMonitors=lambda *_: None, XRRFreeMonitors=lambda *_: None)
        with patch.object(helper.ctypes.util, 'find_library', return_value='fake-libXrandr'), patch.object(helper.ctypes, 'CDLL', return_value=library):
            with self.assertRaisesRegex(RuntimeError, 'RandR 1.5'):
                helper.read_primary_geometry(object(), None, 0)

    def test_randr_adapter_frees_monitor_results_on_rejected_geometry(self):
        storage = (helper.XRRMonitorInfo * 2)()
        storage[0].width = storage[1].width = 1920
        storage[0].height = storage[1].height = 1080
        storage[1].x = 1920
        freed = []
        def version(_display, major, minor):
            ctypes.cast(major, ctypes.POINTER(ctypes.c_int))[0] = 1
            ctypes.cast(minor, ctypes.POINTER(ctypes.c_int))[0] = 5
            return 1
        def monitors(_display, _root, _active, count):
            ctypes.cast(count, ctypes.POINTER(ctypes.c_int))[0] = 2
            return storage
        library = SimpleNamespace(XRRQueryVersion=version, XRRGetOutputPrimary=lambda *_: 0,
                                  XRRGetMonitors=monitors, XRRFreeMonitors=lambda value: freed.append(value))
        x11 = SimpleNamespace(XScreenCount=lambda *_: 1, XRootWindow=lambda *_: 42,
                              XDisplayWidth=lambda *_: 3840, XDisplayHeight=lambda *_: 1080)
        with patch.object(helper.ctypes.util, 'find_library', return_value='fake-libXrandr'), patch.object(helper.ctypes, 'CDLL', return_value=library):
            with self.assertRaisesRegex(RuntimeError, 'unique primary'):
                helper.read_primary_geometry(x11, None, 0)
        self.assertEqual(len(freed), 1)

unittest.main(argv=['input-geometry'], verbosity=2)
`;

test('Linux primary-monitor geometry and safe XRandR fallback (10 pure/stub cases)', { timeout: 10000 }, (t) => {
  const result = spawnSync('python3', ['-c', checks, fileURLToPath(new URL('../desktop/native/phremote-input-linux.py', import.meta.url))], {
    encoding: 'utf8', timeout: 8000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.error?.code === 'ENOENT') { t.skip('Python 3 is unavailable; Linux geometry verification requires Python 3.'); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 10 tests/);
});
