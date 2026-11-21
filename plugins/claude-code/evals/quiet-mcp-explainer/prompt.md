---
name: quiet-mcp-explainer
description: >-
  Should not fire. A general question about MCP servers is near the plugin's subject (it works
  over an MCP connector) but asks nothing about the person's record, so the quadron skill stays
  unused and neither UserPromptSubmit reminder appears.
tags: [should-not-fire, adjacent]
expected_outcome: >-
  No quadron skill call in either arm; neither the recall nor the capture reminder is in the trace.
max_turns: 6
---
In three sentences, what is an MCP server and why would a command-line tool use one?
