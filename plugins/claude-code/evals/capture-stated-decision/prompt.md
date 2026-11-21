---
name: capture-stated-decision
description: >-
  Should fire. A decision stated in the person's own words ("we'll go with ...") with no request
  to save loads the quadron skill and gets the capture reminder; the reply claims no save and
  does not use AskUserQuestion to offer it.
tags: [should-fire, capture, hook-reminder]
expected_outcome: >-
  The quadron skill is invoked; the capture reminder is in the trace; no AskUserQuestion call;
  no save is claimed.
max_turns: 6
---
ok, we'll go with Postgres over DynamoDB for the billing service; the reporting queries need joins
