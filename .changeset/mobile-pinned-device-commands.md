---
"@e2e-dev/mobile": patch
---

Closing an app, clearing its state, resetting the keychain, the `device` settings, and the screen recorder now name the target's device, as boot, open, install, and permission changes already did. With more than one simulator or emulator booted, `device.closeApp()`, `app.clearState()`, `device.clearKeychain()`, `device.setAppearance()` and the other settings, and `--video` failed with `N devices match this request equally` whenever agent-device's session was not bound to a device: after `closeApp`, in a later file, and in the worker that replaced one after a failed test, where every following test failed the same way.
