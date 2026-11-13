// PERM-1 guard. It shows that every session the harness starts is dontAsk with no canUseTool and no
// bypass flag, that a Quadron capture the turn did not allow is a recorded denial and never a prompt,
// and that each other permission mode is refused before any query starts. It does not show what the SDK
// does in default or bypassPermissions mode, or whether a person would see a prompt: no session runs in
// those modes, and the fake client has no callback path. What the docs say, read 2026-11-11, not measured:
//
//   https://code.claude.com/docs/en/agent-sdk/agent-loop#permission-mode
//     default: "Tool calls that need approval and aren't covered by allow rules trigger your canUseTool
//     callback; no callback means deny"
//     bypassPermissions: "Runs tool calls without asking for approval, including calls to tools you
//     didn't list in allowedTools. A few calls still go to your canUseTool callback"
//   https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes
//     dontAsk: "Any call that would otherwise prompt is denied without calling canUseTool"
import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../lib/main.mjs";
import { HOOK_ROW_NAMES } from "../lib/rows.mjs";
import { box, fakeClient, liveEnv, init, result, toolUse, assistantText, CAPTURE, T2_OK, T4_OK, T5_OK } from "./helpers.mjs";

const [, , T2H, T1M] = HOOK_ROW_NAMES;
const OTHER_MODES = ["default", "bypassPermissions", "acceptEdits", "plan", "auto"];
const T2H_OFFER = "Want me to keep that in Quadron: you bill annually only, with monthly ruled out?";

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = fakeClient(scripts);
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const noCallback = (client, label) => {
  assert.ok(client.calls.length > 0, label);
  for (const { options: o } of client.calls) {
    assert.equal(o.permissionMode, "dontAsk", label);
    assert.equal("canUseTool" in o, false, label);
    assert.equal("allowDangerouslySkipPermissions" in o, false, label);
    assert.equal("permissionPrompts" in o, false, label);
  }
};

test("PERM-1. every session the harness starts is dontAsk with no callback and no bypass flag", async () => {
  const quiet = (sid) => [init({ session_id: sid }), assistantText("An answer."), result(0.1, { session_id: sid, result: "An answer." })];
  for (const [row, scripts] of [
    ["T2", [T2_OK()]],
    ["T4", T4_OK()],
    ["T5", T5_OK()],
    [T2H, [quiet("t2h")]],
    [T1M, [quiet("m1"), quiet("m1")]],
  ]) {
    const b = box();
    const { client } = await run(b, b.argv(row), scripts);
    noCallback(client, row);
  }
});

test("PERM-1. a capture call the turn did not allow is a recorded denial, and no callback existed to approve it", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv(T2H), [[
    init({ session_id: "t2h" }), toolUse("c", CAPTURE, { decided: "annually" }), assistantText(T2H_OFFER), result(0.1, { session_id: "t2h", result: T2H_OFFER }),
  ]]);
  assert.ok(!client.calls[0].options.allowedTools.includes(CAPTURE)); // visible, not allowed
  assert.deepEqual(client.denials.map((d) => d.tool_name), [CAPTURE]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.summary.verdict, "FAIL");
  assert.match(r.summary.notes.join(" "), /captured before confirmation|capture tool was called/);
  noCallback(client, T2H);
});

test("PERM-1. the guard refuses each of the other permission modes before any query", async () => {
  for (const m of OTHER_MODES) {
    const b = box();
    const out = await run(b, b.argv("T2"), [T2_OK()], { testOptionsHook: (o) => ({ ...o, permissionMode: m }) });
    assert.equal(out.r.exitCode, 2, m);
    assert.equal(out.r.refused, true, m);
    assert.equal(out.client.calls.length, 0, m);
    assert.deepEqual(out.client.prompts, [], m);
    assert.deepEqual(b.recordLines(), [], m);
  }
});
