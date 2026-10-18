import Foundation
import ApplicationServices
import Darwin

func output(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func finiteNumber(_ value: Any?, _ lower: Double, _ upper: Double) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    let number = value.doubleValue
    return number.isFinite && number >= lower && number <= upper ? number : nil
}

final class InputEngine {
    private let lock = NSLock()
    private let source = CGEventSource(stateID: .hidSystemState)
    private var keys = Set<CGKeyCode>()
    private var buttons = Set<Int>()
    private var point: CGPoint
    private let bounds = CGDisplayBounds(CGMainDisplayID())
    private let keyMap: [String: CGKeyCode] = [
        "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,"KeyB":11,"KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,
        "Digit1":18,"Digit2":19,"Digit3":20,"Digit4":21,"Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,"Digit7":26,"Minus":27,"Digit8":28,"Digit0":29,"BracketRight":30,"KeyO":31,"KeyU":32,"BracketLeft":33,"KeyI":34,"KeyP":35,
        "Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,"Semicolon":41,"Backslash":42,"Comma":43,"Slash":44,"KeyN":45,"KeyM":46,"Period":47,"Tab":48,"Space":49,"Backquote":50,"Backspace":51,"Escape":53,
        "MetaRight":54,"MetaLeft":55,"ShiftLeft":56,"CapsLock":57,"AltLeft":58,"ControlLeft":59,"ShiftRight":60,"AltRight":61,"ControlRight":62,
        "F17":64,"NumpadDecimal":65,"NumpadMultiply":67,"NumpadAdd":69,"NumLock":71,"NumpadDivide":75,"NumpadEnter":76,"NumpadSubtract":78,"F18":79,"F19":80,"NumpadEqual":81,"Numpad0":82,"Numpad1":83,"Numpad2":84,"Numpad3":85,"Numpad4":86,"Numpad5":87,"Numpad6":88,"Numpad7":89,"F20":90,"Numpad8":91,"Numpad9":92,
        "F5":96,"F6":97,"F7":98,"F3":99,"F8":100,"F9":101,"F11":103,"F13":105,"F16":106,"F14":107,"F10":109,"F12":111,"F15":113,"Insert":114,"Home":115,"PageUp":116,"Delete":117,"F4":118,"End":119,"F2":120,"PageDown":121,"F1":122,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126
    ]

    init() { point = CGPoint(x: bounds.midX, y: bounds.midY) }

    private func flags(_ object: [String: Any]) throws -> CGEventFlags {
        guard object["modifiers"] == nil || object["modifiers"] is [String: Any] else { throw InputError.invalid }
        let modifiers = object["modifiers"] as? [String: Any] ?? [:]
        var flags: CGEventFlags = []
        for (name, flag) in [("shift", CGEventFlags.maskShift), ("ctrl", .maskControl), ("alt", .maskAlternate), ("meta", .maskCommand)] {
            if let value = modifiers[name] {
                guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw InputError.invalid }
                if value.boolValue { flags.insert(flag) }
            }
        }
        return flags
    }

    private func mouseType(_ button: Int, _ down: Bool) -> CGEventType {
        if button == 0 { return down ? .leftMouseDown : .leftMouseUp }
        if button == 2 { return down ? .rightMouseDown : .rightMouseUp }
        return down ? .otherMouseDown : .otherMouseUp
    }

    private func mouseButton(_ button: Int) -> CGMouseButton { button == 0 ? .left : button == 2 ? .right : .center }

    private func postMouse(_ type: CGEventType, _ button: Int, _ flags: CGEventFlags) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: mouseButton(button))
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
    }

    func apply(_ object: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        if object["kind"] as? String == "control", object["event"] as? String == "releaseAll" { releaseLocked(); return }
        guard object["kind"] as? String == "input", let action = object["event"] as? String else { throw InputError.invalid }
        let modifiers = try flags(object)
        for name in ["x", "y"] { if object[name] != nil && finiteNumber(object[name], 0, 1) == nil { throw InputError.invalid } }
        if ["move", "down", "up"].contains(action) {
            guard let x = finiteNumber(object["x"], 0, 1), let y = finiteNumber(object["y"], 0, 1) else { throw InputError.invalid }
            point = CGPoint(x: bounds.minX + x * max(0, bounds.width - 1), y: bounds.minY + y * max(0, bounds.height - 1))
        }
        switch action {
        case "move":
            let button = buttons.contains(0) ? 0 : buttons.contains(2) ? 2 : 1
            let type: CGEventType = buttons.isEmpty ? .mouseMoved : button == 0 ? .leftMouseDragged : button == 2 ? .rightMouseDragged : .otherMouseDragged
            postMouse(type, button, modifiers)
        case "down", "up":
            guard let number = finiteNumber(object["button"], 0, 2), number.rounded() == number else { throw InputError.invalid }
            let button = Int(number)
            if action == "down" { buttons.insert(button) } else { buttons.remove(button) }
            postMouse(mouseType(button, action == "down"), button, modifiers)
        case "scroll":
            guard let dx = finiteNumber(object["deltaX"] ?? 0, -2000, 2000), let dy = finiteNumber(object["deltaY"] ?? 0, -2000, 2000) else { throw InputError.invalid }
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0)
            event?.flags = modifiers
            event?.post(tap: .cghidEventTap)
        case "keyDown", "keyUp":
            guard let code = object["code"] as? String, let virtual = keyMap[code] else { throw InputError.unsupportedKey }
            let down = action == "keyDown"
            let repeated = down && keys.contains(virtual)
            if down { keys.insert(virtual) } else { keys.remove(virtual) }
            let event = CGEvent(keyboardEventSource: source, virtualKey: virtual, keyDown: down)
            event?.flags = modifiers
            event?.setIntegerValueField(.keyboardEventAutorepeat, value: repeated ? 1 : 0)
            event?.post(tap: .cghidEventTap)
        case "text":
            guard let text = object["text"] as? String, !text.isEmpty, text.utf16.count <= 512, text.utf8.count <= 4096, !text.contains("\0") else { throw InputError.invalid }
            let utf16 = Array(text.utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                utf16.withUnsafeBufferPointer { buffer in event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress) }
                event?.flags = []
                event?.post(tap: .cghidEventTap)
            }
        default: throw InputError.invalid
        }
    }

    private func releaseLocked() {
        for key in keys {
            let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
            event?.flags = []
            event?.post(tap: .cghidEventTap)
        }
        keys.removeAll()
        for button in buttons { postMouse(mouseType(button, false), button, []) }
        buttons.removeAll()
    }

    func releaseAll() { lock.lock(); defer { lock.unlock() }; releaseLocked() }
}

enum InputError: Error { case invalid, unsupportedKey }

let permission = AXIsProcessTrusted()
output(["type": "ready", "supported": true, "permission": permission, "status": permission ? "ready" : "permission-required", "message": permission ? "Remote input ready on the main display." : "Enable Accessibility access for phRemote in macOS System Settings, then approve a new session."])
if CommandLine.arguments.contains("--check-permissions") { exit(permission ? 0 : 2) }
guard permission else { exit(2) }
let engine = InputEngine()
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
    source.setEventHandler { engine.releaseAll(); exit(0) }
    source.resume()
    signalSources.append(source)
}
defer { engine.releaseAll() }
while let line = readLine(strippingNewline: true) {
    do {
        guard line.utf8.count <= 16384, let data = line.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw InputError.invalid }
        try engine.apply(object)
        if object["kind"] as? String == "control", object["event"] as? String == "releaseAll" {
            output(["type": "released"])
        }
    } catch InputError.unsupportedKey {
        engine.releaseAll()
        output(["type": "error", "released": true, "releaseAttempted": true, "message": "This key is unsupported on macOS. Held input was released."])
    } catch {
        engine.releaseAll()
        output(["type": "error", "released": true, "releaseAttempted": true, "message": "Invalid input event was rejected. Held input was released."])
    }
}
