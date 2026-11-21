---
name: quiet-git-keep-changes
description: >-
  Should not fire. A git question whose wording sits near the trigger phrases ("remind me",
  "keep the changes") but matches none of them leaves the quadron skill unused and gets neither
  UserPromptSubmit reminder.
tags: [should-not-fire, near-miss, hook-precision]
expected_outcome: >-
  No quadron skill call in either arm; neither the recall nor the capture reminder is in the trace.
max_turns: 6
---
remind me how to undo my last git commit but keep the changes in my working tree
