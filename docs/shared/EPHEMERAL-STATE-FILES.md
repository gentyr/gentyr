# Ephemeral State Files Under Sticky-Bit Protection

How GENTYR manages runtime state files in `.claude/` when the directory has sticky-bit protection (`chmod 1755`).

## The Problem

GENTYR protects `.claude/` with a sticky bit to prevent agents from creating or deleting files. This means:

- **Creating new files fails** with EACCES
- **Deleting files (`unlinkSync`) fails** with EACCES
- **Overwriting existing files (`writeFileSync`) works** because it modifies content, not directory entries

Hooks and MCP servers that use create/delete semantics for ephemeral tokens (approval tokens, bypass tokens) will crash under protection.

## The Pattern: Pre-Create + Overwrite

All ephemeral state files in `.claude/` follow this lifecycle:

### 1. Pre-create during setup

`scripts/setup.sh` pre-creates every state file with `{}` before applying sticky-bit protection:

```bash
for state_file in \
    "$PROJECT_DIR/.claude/bypass-approval-token.json" \
    "$PROJECT_DIR/.claude/commit-approval-token.json" \
    "$PROJECT_DIR/.claude/protection-state.json" \
    "$PROJECT_DIR/.claude/protected-action-approvals.json"; do
    [ -f "$state_file" ] || echo '{}' > "$state_file"
done
```

### 2. Write to activate

When a token/state needs to be set, overwrite the file with the full payload:

```javascript
fs.writeFileSync(tokenPath, JSON.stringify({
  code: 'ABC123',
  expires_timestamp: Date.now() + 300000,
  // ...
}));
```

### 3. Overwrite with `{}` to consume/clear

Instead of deleting the file, overwrite it with an empty object:

```javascript
// WRONG - fails under sticky-bit
fs.unlinkSync(tokenPath);

// CORRECT - works under sticky-bit
fs.writeFileSync(tokenPath, '{}');
```

### 4. Treat `{}` as "no token"

Readers must check for empty objects before processing:

```javascript
const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

// Empty object = consumed/cleared token
if (!token.code && !token.request_id) {
  return false; // No valid token
}
```

## Files Using This Pattern

| File | Written By | Consumed By |
|------|-----------|-------------|
| `commit-approval-token.json` | deputy-cto MCP server | pre-commit-review hook |
| `bypass-approval-token.json` | bypass-approval hook | block-no-verify hook, deputy-cto server |
| `protected-action-approvals.json` | protected-action-gate hook | protected-action-gate hook |
| `protection-state.json` | setup.sh | various hooks |
| `hourly-automation-state.json` | hourly automation | hourly automation |
| `plan-executor-state.json` | plan executor | plan executor |

## Adding a New State File

1. **Add to `setup.sh` pre-creation loop** (line ~595) so it exists before protection
2. **Use `writeFileSync` to write** -- never use conditional create (`O_CREAT | O_EXCL`)
3. **Use `writeFileSync(path, '{}')` to clear** -- never use `unlinkSync`
4. **Check for empty `{}` in readers** -- treat as "no data"
5. **Add to `.gitignore`** via setup.sh gitignore generation if not already listed
6. **Add to credential-file-guard** if the file contains sensitive data

## Common Mistakes

### Using `existsSync` as "has token" check

Under this pattern, the file always exists. Check the *content*, not the file's existence:

```javascript
// Incomplete - file always exists under protection
if (!fs.existsSync(tokenPath)) {
  return false;
}

// Also need this:
const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
if (Object.keys(token).length === 0) {
  return false; // Token was cleared
}
```

### Forgetting to add to setup.sh

If a new state file isn't pre-created, the first write attempt will fail with EACCES. Always add new files to the pre-creation loop in `setup.sh`.

### Using `unlinkSync` in error/cleanup paths

Every code path that touches a token file must use overwrite, not delete. This includes error handlers, expiry cleanup, forgery detection, and consumption paths.
