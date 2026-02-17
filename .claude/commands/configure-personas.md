<!-- HOOK:GENTYR:configure-personas -->
# /configure-personas - AI User Feedback Persona Configuration

You are now in **persona configuration mode**. This interactive session lets you set up AI user personas that automatically test your application from a real user's perspective.

The prefetch hook has pre-gathered existing personas, features, and mappings and injected them as a `[PREFETCH:configure-personas]` systemMessage above. Use that data for Step 1 instead of calling list MCP tools. If the prefetch data is missing, call the MCP tools directly.

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

## Session Flow

### 1. Show Current Configuration

Start by listing existing personas and features:

```
1. mcp__user-feedback__list_personas()
2. mcp__user-feedback__list_features()
```

Present a summary table:
- Personas: name, mode (gui/cli/api/sdk), enabled, # features mapped
- Features: name, category, # file patterns, # personas mapped

### 2. Interactive Menu

Present these options and wait for user input:

1. **Create persona** - Guided flow: name, description, consumption mode, behavior traits, endpoints, credentials
2. **Edit persona** - Select persona, modify fields
3. **Delete persona** - Select and confirm deletion
4. **Register feature** - Define feature with file glob patterns and URL patterns
5. **Delete feature** - Select and confirm deletion
6. **Map persona to feature** - Select persona + feature, set priority and test scenarios
7. **Unmap persona from feature** - Remove a mapping
8. **Dry run** - Enter file paths to see which personas would trigger
9. **Done** - Exit configuration mode

### 3. Guided Persona Creation

When creating a persona, walk the user through:

1. **Name**: Short identifier (e.g., "power-user", "first-time-visitor", "mobile-user")
2. **Description**: Who this persona represents and their goals
3. **Consumption mode**: How they interact with the product
   - `gui` - Web browser (uses Playwright for visual testing)
   - `cli` - Command-line interface
   - `api` - REST/GraphQL API
   - `sdk` - Programming SDK/library
4. **Behavior traits**: List of behavioral characteristics (e.g., "impatient", "explores all menus", "uses keyboard shortcuts", "non-technical")
5. **Endpoints**: URLs or paths this persona accesses (e.g., "http://localhost:3000", "/api/v1")
6. **Credentials reference**: Optional 1Password reference (op:// vault ref) or credential key name

### 4. Guided Feature Registration

When registering a feature:

1. **Name**: Feature identifier (e.g., "user-authentication", "billing-dashboard")
2. **Description**: What this feature does
3. **File patterns**: Glob patterns matching source files (e.g., `src/auth/**`, `lib/billing/*.ts`)
4. **URL patterns**: Route patterns for web features (e.g., `/login`, `/api/v1/billing/*`)
5. **Category**: Optional grouping (e.g., "auth", "billing", "settings")

### 5. Dry Run

For dry runs, ask the user for a list of changed files (or suggest running `git diff --name-only` to get them), then call `get_personas_for_changes` and present which personas would be triggered, which features matched, and the specific test scenarios.

## Communication Style

- Be conversational and helpful
- After each operation, show the updated state
- Offer suggestions (e.g., "You have a GUI persona but no features with URL patterns - consider adding some")
- Validate inputs before submitting (e.g., warn if file patterns look wrong)
- After creating a persona, suggest mapping it to features
- After registering a feature, suggest mapping personas to it

## Example Interaction

```
Configuration Summary:
  Personas: 0 configured
  Features: 0 registered

What would you like to do?
1. Create persona
2. Register feature
3. Done

User: 1

Let's create a new persona. What should we call them?

User: power-user

Great name! Describe who "power-user" is and what they're trying to accomplish:

User: An experienced user who knows the product well, uses keyboard shortcuts, and tries edge cases

What consumption mode does this persona use?
1. gui - Web browser (visual testing with Playwright)
2. cli - Command-line interface
3. api - REST/GraphQL API
4. sdk - Programming SDK

User: 1

Any behavioral traits? (comma-separated, or "skip")

User: impatient, uses keyboard shortcuts, tries edge cases, power user

Endpoints this persona accesses? (comma-separated URLs, or "skip")

User: http://localhost:3000

Credential reference? (op:// vault ref or key name, or "skip")

User: skip

Created persona "power-user" (gui mode, 4 traits, 1 endpoint).

Would you like to map this persona to a feature? You'll need to register features first
if you haven't already.
```
