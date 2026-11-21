---
name: capture-remember-this
description: >-
  Should fire. A bare "remember this" that does not name Quadron loads the quadron skill and
  gets the capture reminder. The reply asks in a plain sentence (no AskUserQuestion call) and
  does not claim a save; the run has no quad_* tools, so nothing can be saved.
tags: [should-fire, capture, hook-reminder]
expected_outcome: >-
  The quadron skill is invoked; the capture reminder is in the trace; no AskUserQuestion call;
  the reply asks whether Quadron is meant or says Quadron is not connected, and claims no save.
max_turns: 6
---
remember this: for client proposals I always quote a fixed fee, never hourly
