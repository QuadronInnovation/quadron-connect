---
type: tool_used
tool: Skill
input_match: '"skill"\s*:\s*"(?:[\w-]+:)?quadron"'
min: 0
max: 0
arm: both
---
The quadron skill is never invoked, by its own name or its namespaced `plugin-name:quadron`
form, in either arm (Q5, Q12, Q14 in evals/README.md). Calls to other skills are not checked.
