---
"e2e": patch
---

Expose `run()` from `e2e/runner` to execute suites with a config file or runtime configuration, stream progress, cancel execution, and return the completed report without exiting the caller.

`openHost` called while a suite is running now fails early with `RUNNER_BUSY`.
