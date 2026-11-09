@AGENTS.md

## Claude Code notes

- Read the relevant section of `documents/Expense Tracker — Technical Spec.md` before implementing; don't load the whole file when one section is enough.
- `.claude/settings.json` denies deploys, secrets, remote D1 and reading `.dev.vars`. Don't work around these; ask the user to run them.
- For Cloudflare API details (Workers AI models, Queues limits, D1, Wrangler flags), check current Cloudflare docs rather than memory.
