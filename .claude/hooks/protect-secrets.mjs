#!/usr/bin/env node
// PreToolUse hook: deny agent read/write access to .dev.vars and .env files.
// Shared by Claude Code (.claude/settings.json) and Codex (.codex/hooks.json).
// Backs up the Read/Edit deny rules in settings.json and also covers Write,
// NotebookEdit, Grep and Bash, which those rules don't. Best effort: a
// determined shell glob can still slip past the Bash check.
// Committed templates stay allowed: `*.example` and `*.sample`
// (e.g. .dev.vars.example, .dev.vars.sample, .env.sample).
//
// Codex reports edits as tool_name "apply_patch" with the whole patch under
// tool_input.command, and every shell tool as "Bash" (command may be an argv
// array). Only the patch's file headers are checked, so a doc that merely
// mentions .env stays editable.

import { basename } from "node:path";

const SECRET_NAME = /^\.(?:dev\.vars|env)(?:\..+)?$/;
// In shell text: `.dev.vars` / `.env` (+ optional suffix) not glued to a
// preceding identifier, so `process.env.FOO` doesn't match but `worker/.env` does.
const SECRET_IN_SHELL = /(?:^|[^\w.$-])(\.(?:dev\.vars|env)(?:\.[\w.-]*)?)(?=$|[^\w.-])/g;

const TEMPLATE_SUFFIXES = [".example", ".sample"];
const isTemplate = (name) => TEMPLATE_SUFFIXES.some((s) => name.endsWith(s));
const isSecretPath = (p) => {
  if (typeof p !== "string" || p === "") return false;
  const name = basename(p);
  return SECRET_NAME.test(name) && !isTemplate(name);
};

const commandText = (c) =>
  Array.isArray(c) ? c.join(" ") : typeof c === "string" ? c : "";

function check(tool, input) {
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return isSecretPath(input.file_path) ? input.file_path : null;
    case "NotebookEdit":
      return isSecretPath(input.notebook_path) ? input.notebook_path : null;
    case "Grep": {
      if (isSecretPath(input.path)) return input.path;
      const glob = typeof input.glob === "string" ? input.glob : "";
      return /\.(?:dev\.vars|env)\b/.test(glob) && !isTemplate(glob) ? glob : null;
    }
    case "apply_patch": {
      const patch = commandText(input.command);
      for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
        const target = m[1].trim();
        if (isSecretPath(target)) return target;
      }
      return null;
    }
    case "Bash": {
      const cmd = commandText(input.command);
      for (const m of cmd.matchAll(SECRET_IN_SHELL)) {
        if (!isTemplate(m[1])) return m[1];
      }
      return null;
    }
    default:
      return null;
  }
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0); // not our business; let other checks decide
}

const hit = check(payload.tool_name, payload.tool_input ?? {});
if (hit) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked: ${payload.tool_name} touches a secrets file (${hit}). ` +
          "Agents must not read or write .dev.vars / .env files; ask the user to do it.",
      },
    }),
  );
}
process.exit(0);
