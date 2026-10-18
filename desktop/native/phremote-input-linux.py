#!/usr/bin/env python3
"""Local input helper using the existing X11 session and bounded stdin JSON."""
import ctypes
import ctypes.util
import json
import math
import os
import signal
import sys


def output(**message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Invalid numeric input.")
    return value


KEY_NAMES = {
    **{f"Key{chr(65 + n)}": chr(97 + n) for n in range(26)},
    **{f"Digit{n}": str(n) for n in range(10)},
    **{f"Numpad{n}": f"KP_{n}" for n in range(10)},
    **{f"F{n}": f"F{n}" for n in range(1, 21)},
    "Enter": "Return", "Escape": "Escape", "Backspace": "BackSpace", "Tab": "Tab", "Space": "space",
    "Minus": "minus", "Equal": "equal", "BracketLeft": "bracketleft", "BracketRight": "bracketright",
    "Backslash": "backslash", "Semicolon": "semicolon", "Quote": "apostrophe", "Backquote": "grave",
    "Comma": "comma", "Period": "period", "Slash": "slash", "CapsLock": "Caps_Lock", "Insert": "Insert",
    "Delete": "Delete", "Home": "Home", "End": "End", "PageUp": "Prior", "PageDown": "Next",
    "ArrowLeft": "Left", "ArrowRight": "Right", "ArrowUp": "Up", "ArrowDown": "Down",
    "ShiftLeft": "Shift_L", "ShiftRight": "Shift_R", "ControlLeft": "Control_L", "ControlRight": "Control_R",
    "AltLeft": "Alt_L", "AltRight": "Alt_R", "MetaLeft": "Super_L", "MetaRight": "Super_R",
    "NumpadDecimal": "KP_Decimal", "NumpadMultiply": "KP_Multiply", "NumpadAdd": "KP_Add",
    "NumpadSubtract": "KP_Subtract", "NumpadDivide": "KP_Divide", "NumpadEnter": "KP_Enter",
    "NumpadEqual": "KP_Equal", "NumLock": "Num_Lock", "ScrollLock": "Scroll_Lock",
    "PrintScreen": "Print", "Pause": "Pause", "ContextMenu": "Menu",
}
MODIFIER_KEYS = {"shift": ("Shift_L", "Shift_R"), "ctrl": ("Control_L", "Control_R"), "alt": ("Alt_L", "Alt_R"), "meta": ("Super_L", "Super_R")}


class XRRMonitorInfo(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_ulong), ("primary", ctypes.c_int), ("automatic", ctypes.c_int),
        ("noutput", ctypes.c_int), ("x", ctypes.c_int), ("y", ctypes.c_int),
        ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("mwidth", ctypes.c_int), ("mheight", ctypes.c_int),
        ("outputs", ctypes.POINTER(ctypes.c_ulong)),
    ]


def select_primary_geometry(monitors, primary_output, root_width, root_height):
    """Resolve only an evidenced primary monitor; never guess from root size."""
    if not isinstance(monitors, list) or not 1 <= len(monitors) <= 64:
        raise RuntimeError("X11 did not report an active monitor. This session remains view-only.")
    if any(type(value) is not int or value <= 0 for value in (root_width, root_height)):
        raise RuntimeError("The X11 desktop geometry is unavailable.")
    for monitor in monitors:
        if any(type(monitor.get(name)) is not int for name in ("x", "y", "width", "height")):
            raise RuntimeError("The X11 monitor geometry is invalid.")
        x, y, width, height = (monitor[name] for name in ("x", "y", "width", "height"))
        if x < 0 or y < 0 or width < 1 or height < 1 or x + width > root_width or y + height > root_height:
            raise RuntimeError("The X11 monitor geometry is outside the desktop.")
    flagged = [monitor for monitor in monitors if monitor.get("primary") is True]
    matched = [monitor for monitor in monitors if primary_output and primary_output in monitor.get("outputs", [])]
    if primary_output:
        if len(matched) != 1 or len(flagged) > 1 or (flagged and flagged[0] is not matched[0]):
            raise RuntimeError("X11 reported an ambiguous primary monitor. Configure a primary display; this session remains view-only.")
        selected = matched[0]
    elif len(flagged) == 1:
        selected = flagged[0]
    elif len(monitors) == 1 and not flagged:
        # XRandR positively identified one active monitor; its own bounds may
        # still differ from the root desktop (for example, unused root space).
        selected = monitors[0]
    else:
        raise RuntimeError("X11 has multiple monitors without a unique primary. Configure a primary display; this session remains view-only.")
    geometry = {name: selected[name] for name in ("x", "y", "width", "height")}
    if geometry["x"] + geometry["width"] - 1 > 32767 or geometry["y"] + geometry["height"] - 1 > 32767:
        raise RuntimeError("The primary monitor exceeds XTest coordinate limits. This session remains view-only.")
    return geometry


def primary_point(geometry, x, y):
    x, y = number(x, 0, 1), number(y, 0, 1)
    return (geometry["x"] + round(x * max(0, geometry["width"] - 1)),
            geometry["y"] + round(y * max(0, geometry["height"] - 1)))


def read_primary_geometry(x11, display, screen):
    library_path = ctypes.util.find_library("Xrandr")
    if not library_path:
        raise RuntimeError("X11 input requires libXrandr to identify the primary monitor. This session remains view-only.")
    try:
        randr = ctypes.CDLL(library_path)
        pointer = ctypes.c_void_p
        functions = [
            ("XRRQueryVersion", [pointer, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)], ctypes.c_int),
            ("XRRGetOutputPrimary", [pointer, ctypes.c_ulong], ctypes.c_ulong),
            ("XRRGetMonitors", [pointer, ctypes.c_ulong, ctypes.c_int, ctypes.POINTER(ctypes.c_int)], ctypes.POINTER(XRRMonitorInfo)),
            ("XRRFreeMonitors", [ctypes.POINTER(XRRMonitorInfo)], None),
        ]
        for name, arguments, result in functions:
            function = getattr(randr, name)
            function.argtypes, function.restype = arguments, result
    except (AttributeError, OSError) as error:
        raise RuntimeError("The installed libXrandr lacks monitor discovery. RandR 1.5 or newer is required; this session remains view-only.") from error
    major, minor = ctypes.c_int(), ctypes.c_int()
    if not randr.XRRQueryVersion(display, ctypes.byref(major), ctypes.byref(minor)) or (major.value, minor.value) < (1, 5):
        raise RuntimeError("The X11 server requires RandR 1.5 or newer to identify the primary monitor. This session remains view-only.")
    if x11.XScreenCount(display) != 1:
        raise RuntimeError("Multiple separate X11 screens are unsupported. This session remains view-only.")
    root = x11.XRootWindow(display, screen)
    primary_output = int(randr.XRRGetOutputPrimary(display, root))
    count = ctypes.c_int()
    values = randr.XRRGetMonitors(display, root, 1, ctypes.byref(count))
    if not values:
        raise RuntimeError("X11 monitor discovery failed. This session remains view-only.")
    try:
        if not 1 <= count.value <= 64:
            raise RuntimeError("X11 monitor discovery returned an invalid monitor count.")
        monitors = []
        for index in range(count.value):
            monitor = values[index]
            if not 0 <= monitor.noutput <= 64 or (monitor.noutput and not monitor.outputs):
                raise RuntimeError("X11 monitor discovery returned invalid output information.")
            monitors.append({
                "x": monitor.x, "y": monitor.y, "width": monitor.width, "height": monitor.height,
                "primary": bool(monitor.primary),
                "outputs": [int(monitor.outputs[n]) for n in range(monitor.noutput)],
            })
        return select_primary_geometry(monitors, primary_output,
                                       x11.XDisplayWidth(display, screen), x11.XDisplayHeight(display, screen))
    finally:
        randr.XRRFreeMonitors(values)


class X11Input:
    def __init__(self):
        x11_path, xtst_path = ctypes.util.find_library("X11"), ctypes.util.find_library("Xtst")
        if not x11_path or not xtst_path:
            raise RuntimeError("X11 remote input requires libX11 and libXtst.")
        self.x11, self.xtst = ctypes.CDLL(x11_path), ctypes.CDLL(xtst_path)
        pointer = ctypes.c_void_p
        self._bind(self.x11, "XOpenDisplay", [ctypes.c_char_p], pointer)
        self._bind(self.x11, "XCloseDisplay", [pointer], ctypes.c_int)
        self._bind(self.x11, "XDefaultScreen", [pointer], ctypes.c_int)
        self._bind(self.x11, "XScreenCount", [pointer], ctypes.c_int)
        self._bind(self.x11, "XRootWindow", [pointer, ctypes.c_int], ctypes.c_ulong)
        self._bind(self.x11, "XDisplayWidth", [pointer, ctypes.c_int], ctypes.c_int)
        self._bind(self.x11, "XDisplayHeight", [pointer, ctypes.c_int], ctypes.c_int)
        self._bind(self.x11, "XStringToKeysym", [ctypes.c_char_p], ctypes.c_ulong)
        self._bind(self.x11, "XKeysymToKeycode", [pointer, ctypes.c_ulong], ctypes.c_ubyte)
        self._bind(self.x11, "XDisplayKeycodes", [pointer, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)], ctypes.c_int)
        self._bind(self.x11, "XGetKeyboardMapping", [pointer, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)], ctypes.POINTER(ctypes.c_ulong))
        self._bind(self.x11, "XFree", [pointer], ctypes.c_int)
        self._bind(self.x11, "XFlush", [pointer], ctypes.c_int)
        self._bind(self.xtst, "XTestQueryExtension", [pointer, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)], ctypes.c_int)
        self._bind(self.xtst, "XTestFakeMotionEvent", [pointer, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong], ctypes.c_int)
        self._bind(self.xtst, "XTestFakeButtonEvent", [pointer, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong], ctypes.c_int)
        self._bind(self.xtst, "XTestFakeKeyEvent", [pointer, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong], ctypes.c_int)
        # Use this process's existing DISPLAY only. Do not select or modify another session.
        self.display = self.x11.XOpenDisplay(os.environ["DISPLAY"].encode())
        if not self.display:
            raise RuntimeError("Cannot access the current X11 DISPLAY. This session remains view-only.")
        values = [ctypes.c_int() for _ in range(4)]
        if not self.xtst.XTestQueryExtension(self.display, *(ctypes.byref(v) for v in values)):
            self.x11.XCloseDisplay(self.display)
            self.display = None
            raise RuntimeError("The current X11 server does not provide XTest. This session remains view-only.")
        self.screen = self.x11.XDefaultScreen(self.display)
        try:
            self.geometry = read_primary_geometry(self.x11, self.display, self.screen)
        except Exception:
            self.x11.XCloseDisplay(self.display)
            self.display = None
            raise
        self.keys, self.buttons = set(), set()
        self.scroll_x = self.scroll_y = 0.0

    @staticmethod
    def _bind(library, name, args, result):
        function = getattr(library, name)
        function.argtypes, function.restype = args, result

    def keycode(self, name):
        code = int(self.x11.XKeysymToKeycode(self.display, self.x11.XStringToKeysym(name.encode("ascii"))))
        if not code:
            raise ValueError("This key is not present in the current X11 keyboard map.")
        return code

    def key(self, code, down):
        if not self.xtst.XTestFakeKeyEvent(self.display, code, int(down), 0):
            raise RuntimeError("XTest could not send a keyboard event.")
        if down:
            self.keys.add(code)
        else:
            self.keys.discard(code)

    def modifiers(self, values, skip=None):
        if not isinstance(values, dict) or any(not isinstance(values.get(name, False), bool) for name in MODIFIER_KEYS):
            raise ValueError("Invalid input modifiers.")
        for name, symbols in MODIFIER_KEYS.items():
            codes = []
            for symbol in symbols:
                try:
                    codes.append(self.keycode(symbol))
                except ValueError:
                    pass
            if not codes:
                if values.get(name, False):
                    raise ValueError("This modifier is unavailable in the current X11 keyboard map.")
                continue
            if skip in codes:
                continue
            held = self.keys.intersection(codes)
            if values.get(name, False) and not held:
                self.key(codes[0], True)
            elif not values.get(name, False):
                for code in held:
                    self.key(code, False)

    def _text_sequence(self, text):
        # Read the active map; never replace or globally remap keys for Unicode.
        first, last, columns = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
        self.x11.XDisplayKeycodes(self.display, ctypes.byref(first), ctypes.byref(last))
        mapping = self.x11.XGetKeyboardMapping(self.display, first.value, last.value - first.value + 1, ctypes.byref(columns))
        if not mapping:
            raise RuntimeError("Cannot read the current X11 keyboard map.")
        try:
            sequence = []
            for character in text:
                value = ord(character)
                symbol = 0xff0d if character == "\n" else 0xff09 if character == "\t" else value if value <= 0xff else 0x01000000 | value
                match = None
                for code in range(first.value, last.value + 1):
                    for level in range(min(columns.value, 2)):
                        if mapping[(code - first.value) * columns.value + level] == symbol:
                            match = (code, level == 1)
                            break
                    if match:
                        break
                if not match:
                    raise ValueError("Text contains a character unavailable in the current X11 keyboard layout. Use keyboard events instead.")
                sequence.append(match)
            return sequence
        finally:
            self.x11.XFree(mapping)

    def apply(self, message):
        if not isinstance(message, dict):
            raise ValueError("Invalid input event.")
        if message.get("kind") == "control" and message.get("event") == "releaseAll":
            self.release_all()
            return
        if message.get("kind") != "input":
            raise ValueError("Invalid input event.")
        action, modifiers = message.get("event"), message.get("modifiers", {})
        for coordinate in ("x", "y"):
            if coordinate in message:
                number(message[coordinate], 0, 1)
        if action in ("move", "down", "up"):
            x, y = number(message.get("x"), 0, 1), number(message.get("y"), 0, 1)
            if action in ("down", "up"):
                button = number(message.get("button"), 0, 2)
                if int(button) != button:
                    raise ValueError("Invalid pointer button.")
            self.modifiers(modifiers)
            desktop_x, desktop_y = primary_point(self.geometry, x, y)
            self.xtst.XTestFakeMotionEvent(self.display, self.screen, desktop_x, desktop_y, 0)
            if action != "move":
                button = (1, 2, 3)[int(button)]
                self.xtst.XTestFakeButtonEvent(self.display, button, int(action == "down"), 0)
                if action == "down":
                    self.buttons.add(button)
                else:
                    self.buttons.discard(button)
        elif action == "scroll":
            dx, dy = number(message.get("deltaX", 0), -2000, 2000), number(message.get("deltaY", 0), -2000, 2000)
            self.modifiers(modifiers)
            self.scroll_x += dx / 100
            self.scroll_y += dy / 100
            for axis in ("scroll_x", "scroll_y"):
                steps = math.trunc(getattr(self, axis))
                setattr(self, axis, getattr(self, axis) - steps)
                button = (7 if steps > 0 else 6) if axis == "scroll_x" else (5 if steps > 0 else 4)
                for _ in range(min(abs(steps), 20)):
                    self.xtst.XTestFakeButtonEvent(self.display, button, 1, 0)
                    self.xtst.XTestFakeButtonEvent(self.display, button, 0, 0)
        elif action in ("keyDown", "keyUp"):
            name = KEY_NAMES.get(message.get("code"))
            if not name:
                raise ValueError("Unsupported keyboard code.")
            code = self.keycode(name)
            self.modifiers(modifiers, skip=code)
            self.key(code, action == "keyDown")
        elif action == "text":
            text = message.get("text")
            if not isinstance(text, str) or not text or len(text.encode("utf-16-le")) > 1024 or len(text.encode("utf-8")) > 4096 or "\0" in text:
                raise ValueError("Invalid text input.")
            sequence = self._text_sequence(text)
            self.modifiers({})
            shift = self.keycode("Shift_L")
            for code, shifted in sequence:
                if shifted:
                    self.key(shift, True)
                self.key(code, True)
                self.key(code, False)
                if shifted:
                    self.key(shift, False)
        else:
            raise ValueError("Invalid input event.")
        self.x11.XFlush(self.display)

    def release_all(self):
        if not self.display:
            return
        for code in tuple(self.keys):
            self.xtst.XTestFakeKeyEvent(self.display, code, 0, 0)
        for button in tuple(self.buttons):
            self.xtst.XTestFakeButtonEvent(self.display, button, 0, 0)
        self.keys.clear()
        self.buttons.clear()
        self.scroll_x = self.scroll_y = 0.0
        self.x11.XFlush(self.display)

    def close(self):
        if self.display:
            self.release_all()
            self.x11.XCloseDisplay(self.display)
            self.display = None


def main():
    if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        output(type="ready", supported=False, permission=False, status="view-only", message="Wayland is view-only. Remote input requires an X11 session.")
        return 2
    if not os.environ.get("DISPLAY"):
        output(type="ready", supported=False, permission=False, status="view-only", message="No X11 DISPLAY is available.")
        return 2
    try:
        engine = X11Input()
    except Exception as error:
        output(type="ready", supported=False, permission=False, status="view-only", message=str(error))
        return 2
    try:
        output(type="ready", supported=True, permission=True, status="ready", message="X11 remote input ready.")
        if "--check-permissions" in sys.argv:
            return 0
        def terminate(_number, _frame):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGINT, terminate)
        while True:
            line = sys.stdin.buffer.readline(16385)
            if not line:
                break
            if len(line) > 16384:
                while line and not line.endswith(b"\n"):
                    line = sys.stdin.buffer.readline(16385)
                engine.release_all()
                output(type="error", released=True, releaseAttempted=True, message="Oversized input event was rejected.")
                continue
            try:
                message = json.loads(line)
                engine.apply(message)
                if message.get("kind") == "control" and message.get("event") == "releaseAll":
                    output(type="released")
            except Exception as error:
                engine.release_all()
                output(type="error", released=True, releaseAttempted=True, message=str(error)[:512])
    finally:
        engine.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
