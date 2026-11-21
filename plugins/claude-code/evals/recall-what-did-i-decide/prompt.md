---
name: recall-what-did-i-decide
description: >-
  Should fire. A person reaching back to an earlier decision ("what did I decide") loads the
  quadron skill, and the UserPromptSubmit hook adds its recall reminder and not its capture
  reminder.
tags: [should-fire, recall, hook-reminder]
expected_outcome: >-
  The quadron skill is invoked; the recall reminder is in the trace; the capture reminder is not.
max_turns: 6
---
what did I decide about pricing for the Acme renewal? I know I settled it a while back
