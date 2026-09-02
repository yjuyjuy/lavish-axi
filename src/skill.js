// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "about to show something visual" intents.
export const SKILL_DESCRIPTION =
  "Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can " +
  "annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, " +
  "comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.";

// Hard cap so a future regeneration cannot silently re-inflate the skill with CLI-owned
// instructions. The CLI (`lavish-axi --help`, `design`, `playbook`) is the source of truth.
export const MAX_SKILL_MARKDOWN_CHARS = 6000;

// Agent Skills allows only these top-level frontmatter keys; the reference validator
// (skills-ref) rejects anything else outright, and an Agent Plugins client skips a skill
// it cannot validate. Everything else we want to publish has to live under `metadata`.
export const ALLOWED_SKILL_FRONTMATTER_KEYS = Object.freeze([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);

/**
 * Render the installable SKILL.md for the lavish-axi skill.
 *
 * This follows the five-section fleet template (trigger, when to reach for it, curated
 * workflows, conventions, non-goals). Help-derivable content is banned: installed skills
 * go stale;
 * `lavish-axi --help`, `lavish-axi design`, and `lavish-axi playbook <id>` do not.
 * Keep the body to what Lavish is, when to reach for it, how to invoke the CLI,
 * slash-command request handling, and pointers at those commands.
 *
 * The frontmatter is deliberately plain: block-style YAML only (the reference
 * validator rejects `[a, b]` flow collections) and string-valued `metadata`,
 * which is why the Hermes fields are flattened rather than nested.
 *
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown() {
  const markdown = `---
name: lavish-axi
description: ${SKILL_DESCRIPTION}
license: MIT
metadata:
  author: Kun Chen (kunchenguid)
  argument-hint: <what the artifact should show>
  hermes-tags: html, review, artifacts, visualization
  hermes-category: productivity
---

# lavish-axi

Open an agent-generated HTML artifact in the browser as a review surface a human can annotate, then read that feedback back over a long poll.

## When to reach for it

- A plan, comparison, diagram, table, code view, report, prototype, or decision surface will be clearer as a page than as prose: build the HTML, then open it here.
- Structured input from the user (choices, triage, scope) belongs in an artifact with the \`input\` playbook, not in a chat question.
- Do NOT reach for it for a short textual answer, or when nobody is at a browser; answer in the conversation instead.
- Sharing outside this machine is \`export\` (a portable file) or \`share\` (a hosted page), not the review server.

## Workflows

Build the artifact only after reading the current guidance; it is CLI-owned and installed skills go stale.

\`\`\`bash
lavish-axi design                  # design-direction priority, CDN snippet, playbook router
lavish-axi playbook                # list playbook ids
lavish-axi playbook plan           # focused guidance for the artifact you are about to write
\`\`\`

Review loop - open, then wait for the human. The poll is silent by design; never kill it.

\`\`\`bash
lavish-axi .lavish/report.html                       # prints the session url
lavish-axi poll .lavish/report.html                  # blocks until feedback or session end
lavish-axi poll .lavish/report.html --agent-reply "fixed the pricing table"
\`\`\`

Hand the artifact to someone who is not on this box.

\`\`\`bash
lavish-axi export .lavish/report.html --out /tmp/report-standalone.html
lavish-axi share .lavish/report.html --password "<pw>"   # third-party host, public without --password
\`\`\`

Close out or recover.

\`\`\`bash
lavish-axi                          # live sessions, or an empty list
lavish-axi end .lavish/report.html  # agent-side end; a later plain open still works
lavish-axi stop                     # shut the background server down
\`\`\`

## Conventions

Write artifacts under \`.lavish/\` in the working directory unless the user names a place.
Keep sibling assets in that same directory and reference them with relative paths; a leading \`/\` does not resolve.

Every response ends with \`next_step\` or \`help:\` hints; follow them rather than guessing the next command.
Every command takes \`--help\`.

Detected layout issues never return the poll. They wait in the user's Layout issues inbox and arrive as an ordinary \`layout-warnings\` prompt only once the user queues them, so never edit the artifact to chase a layout issue the user did not send.

Run the poll in the foreground unless the harness has a tracked background job that provably wakes the same agent. Never \`nohup\`, \`&\`, or \`disown\` it. A killed poll loses nothing: re-run it.

A browser-side end refuses a later plain reopen; pass \`--reopen\` only when the user asks or something genuinely needs their eyes.

No global install required: \`npx -y lavish-axi ...\` runs every command above, and follow-up commands the CLI prints should be run that way too.

## Non-goals

- Not a design system reference: \`lavish-axi design\` and \`lavish-axi playbook <id>\` own that, and this file must never restate it.
- Not a flag reference. \`--help\` is current; this skill is not.
- \`share --unpublish\` does not delete a hosted page, it overwrites it. The URL still resolves.
- No reverse conversion: whiteboard edits are applied by updating the Mermaid source, never by writing a scene file back.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lavish-axi\` explicitly - fetch the current CLI guidance, then build that artifact.
If it is empty, infer what to visualize from the conversation.
`;

  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it under ${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }

  return markdown;
}

/**
 * Parse SKILL.md frontmatter into a normalized model.
 *
 * Deliberately tiny and strict: it accepts only the block-style shapes Agent Skills
 * permits - flat `key: value` entries plus a single level of indented entries under
 * `metadata:` - and reports anything else rather than guessing. That strictness is the
 * point: a shape this parser rejects is a shape the reference validator rejects too.
 *
 * @param {string} markdown full SKILL.md contents
 * @returns {{ frontmatter: Record<string, string | Record<string, string>>, errors: string[] }}
 */
export function parseSkillFrontmatter(markdown) {
  /** @type {Record<string, string | Record<string, string>>} */
  const frontmatter = {};
  const errors = [];

  if (!markdown.startsWith("---\n")) {
    return { frontmatter, errors: ["frontmatter does not open with `---`"] };
  }
  const end = markdown.indexOf("\n---\n", 3);
  if (end < 0) {
    return { frontmatter, errors: ["frontmatter is not closed with `---`"] };
  }

  let parentKey = null;
  for (const line of markdown.slice(4, end + 1).split("\n")) {
    if (line.trim() === "") continue;

    const indented = /^ {2}\S/.test(line);
    if (!indented && /^\s/.test(line)) {
      errors.push(`unsupported indentation: ${line}`);
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) {
      errors.push(`not a \`key: value\` entry: ${line.trim()}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (value.startsWith("[") || value.startsWith("{")) {
      errors.push(`\`${key}\` uses a YAML flow collection, which the reference validator rejects`);
      continue;
    }

    if (indented) {
      if (parentKey === null) {
        errors.push(`\`${key}\` is indented under no parent key`);
        continue;
      }
      if (value === "") {
        errors.push(`\`${parentKey}.${key}\` nests deeper than one level`);
        continue;
      }
      const parent = frontmatter[parentKey];
      if (typeof parent === "object") parent[key] = value;
      continue;
    }

    if (value === "") {
      frontmatter[key] = {};
      parentKey = key;
      continue;
    }
    frontmatter[key] = value;
    parentKey = null;
  }

  return { frontmatter, errors };
}

/**
 * Check a generated SKILL.md against the Agent Skills frontmatter rules that the
 * reference validator enforces. Agent Plugins delegates skill validity wholesale to
 * that spec and silently skips skills that fail it, so this doubles as the plugin's
 * skills-component check.
 *
 * @param {string} markdown full SKILL.md contents
 * @param {{ directoryName?: string }} [options] directory the skill is published under
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSkillMarkdown(markdown, { directoryName } = {}) {
  const { frontmatter, errors } = parseSkillFrontmatter(markdown);

  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_SKILL_FRONTMATTER_KEYS.includes(key)) {
      errors.push(`unexpected frontmatter field \`${key}\`; allowed: ${ALLOWED_SKILL_FRONTMATTER_KEYS.join(", ")}`);
    }
  }

  const name = frontmatter.name;
  if (typeof name !== "string" || name === "") {
    errors.push("`name` is required");
  } else {
    if (name.length > 64) errors.push("`name` exceeds 64 characters");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push("`name` must be lowercase alphanumeric with single separating hyphens");
    }
    if (directoryName !== undefined && name !== directoryName) {
      errors.push(`directory name \`${directoryName}\` must match skill name \`${name}\``);
    }
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || description === "") {
    errors.push("`description` is required");
  } else if (description.length > 1024) {
    errors.push("`description` exceeds 1024 characters");
  }

  const metadata = frontmatter.metadata;
  if (metadata !== undefined) {
    if (typeof metadata !== "object") {
      errors.push("`metadata` must be a map");
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string" || value === "") {
          errors.push(`\`metadata.${key}\` must be a non-empty string value`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
