---
name: quiet-decision-records
description: >-
  Should not fire. A general question about team decision records sits next to the skill's
  vocabulary (decisions, records) but is not about the person's own Quadron record, so the
  quadron skill stays unused and neither UserPromptSubmit reminder appears.
tags: [should-not-fire, adjacent]
expected_outcome: >-
  No quadron skill call in either arm; neither the recall nor the capture reminder is in the trace.
max_turns: 6
---
How should a small engineering team structure architecture decision records? Give me a short template.
