<!-- HOOK:GENTYR:configure-personas -->
# /configure-personas - AI User Feedback Persona Configuration

You are now in **persona configuration mode**. The prefetch hook has pre-gathered existing personas, features, mappings, and auto-detected feature directories -- all injected as `[PREFETCH:configure-personas]` context above. Use that data throughout this flow instead of calling list MCP tools. If the prefetch data is missing, call the MCP tools directly.

## Available Tools

You have access to `mcp__user-feedback__*` tools for all operations:

**Persona Management:**
- `create_persona` - Create a new user persona
- `update_persona` - Modify an existing persona
- `delete_persona` - Remove a persona and its mappings
- `get_persona` - Get full persona details
- `list_personas` - List all personas

**Feature Management:**
- `register_feature` - Register a project feature with file/URL patterns
- `list_features` - List registered features
- `delete_feature` - Remove a feature

**Mapping:**
- `map_persona_feature` - Connect a persona to a feature with priority and test scenarios
- `unmap_persona_feature` - Disconnect a persona from a feature

**Testing:**
- `get_personas_for_changes` - Dry run: given changed files, which personas would trigger?

---

## Route Selection

Check the prefetch data to determine which track to follow:

- **If 0 personas AND 0 features** → follow **Track A: First-Run Wizard**
- **Otherwise** → follow **Track B: Returning User Menu**

---

## Track A: First-Run Wizard (0 personas, 0 features)

This is an all-in-one guided setup that creates personas, registers features, and maps them together.

### Step 1: Value Pitch

Start by explaining what this system does:

> **What you're setting up:** When you push code to staging, GENTYR diffs the changed files, matches them against feature file patterns, and spawns isolated AI agents -- one per triggered persona -- that test your app from a real user's perspective (browser, CLI, API, or SDK). Their bug reports feed into the deputy-CTO triage pipeline automatically.
>
> This wizard will walk you through creating personas, registering features, and connecting them. It takes about 2 minutes.

### Step 2: Analyze the Project

Read `package.json` (and any other relevant config like `README.md`, framework config files) in the target project to understand:
- What framework is used (Next.js, SvelteKit, Express, etc.)
- Whether the project is a web app, CLI tool, API backend, SDK/library, or a combination
- What the dev server URL likely is
- The project name and a one-line description

Present your findings to the user:

```
Your project:
  Name: {name}
  Type: {web app / CLI tool / API backend / full-stack / etc.}
  Dev URL: {best guess, e.g. http://localhost:3000}
```

Ask the user to confirm or correct your analysis. This determines which persona templates to offer.

### Step 3: Persona Templates

Based on your project analysis, offer appropriate preset personas using `AskUserQuestion` with `multiSelect: true`.

**Template selection by project type:**

- **Web apps**: Offer "New User", "Power User", "API Consumer"
- **CLI tools**: Offer "CLI Beginner", "CI/CD Scripter"
- **API backends**: Offer "API Consumer", "Load Tester"
- **SDK/libraries** (has `main`/`exports` in package.json, no web UI or CLI): Offer "SDK Consumer"
- **Full-stack** (web + API): Offer "New User", "Power User", "API Consumer"
- Always include a "Custom persona" option

**Template definitions:**

| Template | Name | Mode | Description | Traits |
|---|---|---|---|---|
| New User | new-user | gui | A first-time visitor exploring the product with no prior experience | unfamiliar with features, reads instructions carefully, gets confused by jargon, tries obvious path first |
| Power User | power-user | gui | An experienced user who knows the product well and pushes boundaries | uses keyboard shortcuts, tries edge cases, multitabs, moves fast, skips tutorials |
| API Consumer | api-consumer | api | A developer integrating with the API who tests thoroughly | reads API docs first, tests error handling, checks response formats, tries invalid inputs |
| CLI Beginner | cli-beginner | cli | A developer using the CLI for the first time by following the README | follows README, tries basic commands first, confused by abbreviations |
| CI/CD Scripter | cicd-scripter | cli | An automation engineer integrating the CLI into CI/CD pipelines | pipes output, uses --json flags, expects exit codes, tests with large inputs |
| Load Tester | load-tester | api | A QA engineer validating API performance under concurrent load | sends rapid requests, tests rate limits, checks response times, tests concurrent access |
| SDK Consumer | sdk-consumer | sdk | A developer using the library programmatically in their own codebase | reads docs and type signatures, tests edge cases in function arguments, checks return types, tries invalid inputs, tests error throwing, evaluates composability |

### Step 4: Create Selected Personas

**For template personas:** Only ask the user to confirm or modify two things:

1. **Endpoint URL** — pre-fill with the dev URL from your analysis (e.g., `http://localhost:3000`)
   - WHY: "This is where the AI persona will point its browser/requests. Use your local dev URL."
2. **Credentials reference** — optional, ask if they want to link a 1Password vault reference
   - WHY: "If this persona needs to log in, provide an `op://` reference so the AI can authenticate without exposing passwords."

All other fields (name, description, mode, traits) come from the template. Create each persona via `mcp__user-feedback__create_persona`.

**For "Custom persona":** Ask each question with a WHY explanation:

1. **Name** — Short identifier (e.g., "power-user", "mobile-user")
   - WHY: "This becomes the persona's ID. Keep it short and descriptive."
2. **Description** — Who this persona represents and their goals
   - WHY: "The AI reads this to understand who it's pretending to be. Be specific about the user's skill level and goals."
3. **Consumption mode** — gui / cli / api / sdk
   - WHY: "This determines HOW the AI interacts with your app. `gui` uses a real browser via Playwright. `cli` runs terminal commands. `api` sends HTTP requests. `sdk` uses your library programmatically."
4. **Behavior traits** — comma-separated list
   - WHY: "These traits shape the AI's testing strategy. An 'impatient' persona abandons slow pages. A 'thorough' persona checks every form field. A 'non-technical' persona avoids developer tools."
5. **Endpoint** — URL or path
   - WHY: "This is where the AI persona will point its browser/requests."
6. **Credentials reference** — optional op:// vault ref or key name
   - WHY: "If this persona needs to log in, provide an `op://` reference so the AI can authenticate without exposing passwords."

### Step 5: Register Detected Features

Show the auto-detected features from prefetch `detectedFeatures` data. Present them as a selectable list using `AskUserQuestion` with `multiSelect: true`:

```
Detected features in your project:
  1. [x] authentication (src/auth/**)      — from route directory
  2. [x] dashboard (src/app/dashboard/**)   — from route directory
  3. [x] settings (src/app/settings/**)     — from route directory
  4. [ ] components/ui (src/components/ui/**) — from component directory

Select which features to register (or "Other" to add custom features):
```

For each selected feature:
- WHY file patterns: "When you push code and files matching these patterns change, personas mapped to this feature are triggered. The patterns use glob syntax (`**` = recursive, `*` = single level)."
- WHY URL patterns: "URL patterns help GUI personas know which pages to test when this feature changes."
- WHY category: "Categories group related features together for reporting."

Let the user confirm or adjust the auto-suggested `file_patterns`, `url_patterns`, and `category` for each before calling `mcp__user-feedback__register_feature`.

If no features were auto-detected, ask the user to describe their project's main features and create them manually.

After registering features, offer to add more custom features before proceeding.

### Step 6: Smart Auto-Mapping

Propose persona-to-feature mappings based on mode matching:
- `gui` personas → features with URL patterns
- `cli` personas → all features (CLI tools typically test everything)
- `api` personas → features with `/api/` in URL patterns, or all features if no URL patterns exist
- `sdk` personas → all features

Present the proposed mappings in a single confirmation step:

```
Suggested mappings:

  new-user (gui) → authentication (high), dashboard (normal), settings (normal)
  api-consumer (api) → authentication (high), api-endpoints (high)

Accept these mappings? You can modify priorities or remove any mapping.
```

WHY priority: "When multiple features change at once, personas test higher-priority features first. `high`/`critical` features are always tested. `low` priority tests may be skipped when the system is busy."

Create mappings via `mcp__user-feedback__map_persona_feature`.

### Step 7: Dry Run

Automatically run a dry run to show the system working:

1. Get recent changed files: run `git diff --name-only HEAD~3..HEAD` (or `HEAD~1` if that fails) in the target project
2. If there are changed files, call `mcp__user-feedback__get_personas_for_changes` with them
3. Show which personas would trigger and which features matched:

```
Dry run with recent changes:
  Changed files: src/auth/login.ts, src/auth/signup.ts, src/app/dashboard/page.tsx

  Would trigger:
    new-user → authentication (high), dashboard (normal)
    power-user → authentication (high), dashboard (normal)
    api-consumer → authentication (high)

  Your persona feedback system is ready! Push code to staging to see it in action.
```

If no recent changes exist, tell the user the system is configured and will trigger on their next staging push.

### Done

Summarize what was created:
```
Setup complete:
  {N} personas created
  {M} features registered
  {K} mappings configured

Personas will trigger automatically when you push matching code to staging.
Run /configure-personas again to modify this configuration.
```

---

## Track B: Returning User Menu (has existing config)

### Step 1: Rich Summary

Show a comprehensive overview using the prefetch data:

```
Persona Feedback Configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Personas ({count}):
  {name} ({mode}) — mapped to: {feature1}, {feature2} — {enabled/disabled}
  ...

Features ({count}):
  {name} [{category}] — {N} file patterns, {M} personas mapped
  ...

Unmapped personas: {list or "none"}
Unmapped features: {list or "none"}
```

### Step 2: Action Menu

Present a short menu using `AskUserQuestion`:

1. **Add persona** — Create a new persona (uses templates or custom flow from Track A Step 3-4)
2. **Add feature** — Register a new feature (uses auto-detection or manual entry)
3. **Map persona to feature** — Connect existing persona and feature with priority
4. **Dry run** — Test which personas trigger for recent changes
5. **Advanced options** — Edit, delete, unmap, and other operations

### Handling Each Option

**Add persona:** Follow Track A Step 3-4 (template selection or custom creation). After creating, immediately ask: "Map {new-persona} to a feature?" and show available features.

**Add feature:** Show any unregistered detected features from prefetch `detectedFeatures` first. After registering, immediately ask: "Map personas to {new-feature}?" and show available personas with suggested priorities.

**Map persona to feature:** Show unmapped combinations. Ask for priority and optional test scenarios.
- WHY test scenarios: "Without scenarios, the persona explores freely based on its traits. With specific scenarios, it follows a checklist (e.g., 'Try to reset password with invalid email', 'Submit form with all fields empty')."

**Dry run:** Same as Track A Step 7.

**Advanced options submenu:**
1. Edit persona — Select persona, show current values, modify fields
2. Delete persona — Select and confirm (warns about mapping removal)
3. Edit feature — Select feature, modify file/URL patterns
4. Delete feature — Select and confirm (warns about mapping removal)
5. Unmap persona from feature — Show current mappings, select one to remove
6. Back to main menu

### After Each Action

After completing any operation:
1. Show the updated state briefly
2. Return to the main menu (Step 2)
3. Continue until user selects "Done" or similar

---

## Communication Style

- Be conversational and helpful but concise
- Always explain WHY when asking for input (use the WHY explanations above)
- Validate inputs before submitting (warn about suspicious glob patterns, unreachable URLs)
- After each operation, show a brief confirmation of what changed
- Suggest next logical steps (e.g., "You have 2 unmapped features — want to connect them?")
- If the user seems confused, briefly re-explain what personas and features do
