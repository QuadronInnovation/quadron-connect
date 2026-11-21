---
name: quiet-coding-task
description: >-
  Should not fire. An ordinary coding request leaves the quadron skill unused and gets neither
  UserPromptSubmit reminder, while the SessionStart reminder line is still in the session.
tags: [should-not-fire, hook-reminder, session-start]
expected_outcome: >-
  No quadron skill call in either arm; the SessionStart reminder is in the trace; neither the
  recall nor the capture reminder is.
max_turns: 6
---
write a small JavaScript debounce function and show one usage example
