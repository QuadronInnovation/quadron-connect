---
name: recall-names-quadron
description: >-
  Should fire on the skill description alone. The prompt names Quadron but uses none of the
  hook's trigger phrases, so the quadron skill must load from its description and neither
  UserPromptSubmit reminder should appear.
tags: [should-fire, recall, hook-precision]
expected_outcome: >-
  The quadron skill is invoked; neither the recall nor the capture reminder is in the trace.
max_turns: 6
---
Before I write the proposal, can you pull up what I've already got in Quadron on retainer contracts?
