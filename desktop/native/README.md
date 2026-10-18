# Local input helpers

Only Electron main should create `InputController`. Call `start()` after the local
host approves a session, route events only from that session, and await `stop()`
on disconnect, revocation and app quit. Construction and `check()` do not launch a
process. `check()` reports static availability; `permission: null` means a helper
has not checked OS access yet. `start()` resolves to `{ supported, permission,
status, message }`. `apply(event)` returns whether a validated event was accepted.

In development the controller finds this directory next to its module. In a
packaged app copy it to `resources/native` and pass Electron's `process.resourcesPath`
as `resourcesPath`. Include the built macOS executable, rather than expecting a
compiler on the user's computer.

Helpers receive UTF-8 JSON lines on stdin and emit JSON status lines on stdout.
They do not open network connections, elevate privileges, install services or
store input. `{ "kind": "control", "event": "releaseAll" }`, EOF and normal stop
release keys and buttons held by the helper. Main retains responsibility for
consent and session authorization. `stop()` drops pending motion and scroll,
requests release, closes stdin and waits before terminating an unresponsive helper.
Helpers acknowledge explicit release with `{ "type": "released" }` and attempt
cleanup before reporting an input error. If an injector crashes, the controller
starts at most one replacement that sends only releases for keys/buttons touched
by the approved session, followed by EOF. It conservatively retains those presses
until a graceful exit because a queued key-up could be lost in a crash. Recovery
does not resume control. If OS permissions prevent release, the error remains
visible and the local user must press/release the affected modifier. Concurrent
local and remote use of the same key cannot be distinguished by these OS APIs.

Build macOS from the repository root:

```sh
swiftc -O desktop/native/phremote-input-macos.swift -o desktop/native/phremote-input-macos
```

The Swift helper checks Accessibility with `AXIsProcessTrusted()` without opening
a permission prompt. `--check-permissions` emits the check result and exits
without sending input. Enable access in macOS System Settings for the packaged
application/helper and start another approved session. Coordinates cover the
main display and preserve CoreGraphics' global display origin. Text uses Unicode
events; key events use a fixed DOM-code to Mac virtual-key map.

Windows uses the included PowerShell script and fixed C# `SendInput` bindings.
The controller's execution-policy flag applies only to that helper process and
does not change machine policy. Application-control policies can still prevent
it from starting. There is no elevation: higher-integrity applications, UAC and
the secure desktop cannot be controlled. Coordinates cover the primary display;
Unicode text and ordinary key/mouse input are supported. `-CheckPermissions`
initializes the wrapper and exits without sending input. Successful initialization
does not establish that a particular target window accepts `SendInput`.

Linux requires Python 3, libX11, libXtst, libXrandr and an accessible existing
`DISPLAY`. The X11 server must provide RandR 1.5 monitor discovery.
Wayland sessions remain view-only, including when XWayland provides a DISPLAY.
The helper does not alter environment variables or select another login session.
Coordinates cover the primary monitor's physical XRandR bounds, including its
offset within the X11 desktop. The helper checks `XRRGetMonitors` and
`XRRGetOutputPrimary`; it never scales primary-monitor coordinates across the
whole root desktop. One reported active monitor is sufficient even if no primary
flag is set. Ambiguous multiple monitors, separate X screens, missing XRandR or
unsupported monitor discovery keep the session view-only. There is no guessed
root-desktop fallback and no remote monitor selection.
Keyboard codes use the current X11 map. Text supports symbols in that map's first
two levels; unavailable Unicode characters produce an error and never trigger a
global keyboard remap. `--check-permissions` opens/checks X11/XTest and closes it
without sending input.

Input bounds are checked in both JS and native helpers. Motion is coalesced at
120 Hz and scrolling at 60 Hz. Key/button releases bypass the JS rate bucket.
Pointer coordinates use 0..1, browser buttons use 0=left/1=middle/2=right, scroll
deltas are pixels within -2000..2000, and text is limited to 512 UTF-16 units.
The controller permits standard DOM keyboard codes; each OS rejects codes it does
not implement. Text input and printable key events are separate protocol actions:
the sender should choose one path for a character to avoid typing it twice.

Run `node --test tests/input-controller.test.mjs` for lifecycle and crash-recovery
checks. The tests use a temporary Node helper that only records JSON and never
imports native input APIs.
