---
type: regex
target: last_message
pattern: '(?:\bnot|n[''’]t)\s+(?:connected|available|attached)\b|\bno\s+quad_\w*'
flags: i
---
No quad_* tool exists in the run, so the skill's rule for that state applies: say Quadron is not
connected (step 3 in skills/quadron/SKILL.md). This replaces a `trace` regex for the
UserPromptSubmit recall reminder: that hook's output is injected as a system reminder and
"Neither channel produces a visible transcript entry" (https://code.claude.com/docs/en/hooks),
so the reminder line cannot be found in `trace`. It is a heuristic on the reply's wording.
