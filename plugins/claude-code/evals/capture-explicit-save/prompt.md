---
name: capture-explicit-save
description: >-
  Should fire. An explicit "save this to my Quadron record" loads the quadron skill and gets the
  capture reminder. The run has no quad_* tools, so the reply must not claim the save happened.
tags: [should-fire, capture, hook-reminder]
expected_outcome: >-
  The quadron skill is invoked; the capture reminder is in the trace; the reply says plainly that
  nothing was saved and claims no save.
max_turns: 6
---
Save this to my Quadron record: we ruled out per-seat pricing for the starter tier because support cost tracks accounts, not seats.
