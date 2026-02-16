# GitHub MCP Server

MCP server for GitHub repository and workflow management via GitHub API.

## Setup

### Environment Variables

Required:
- `GITHUB_TOKEN`: GitHub personal access token or fine-grained token

### Token Requirements

The GitHub token needs the following scopes:
- `repo` - Full control of private repositories (includes read/write for public repos)
- `workflow` - Update GitHub Actions workflows
- `read:org` - Read org and team membership (optional, for org repos)

To create a token:
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Click "Generate new token" (classic)
3. Select the required scopes above
4. Copy the token and set it as `GITHUB_TOKEN` environment variable

## Installation

After building the package:

```bash
cd packages/mcp-servers
pnpm build
```

Add to Claude Code config:

```bash
# Using npx
claude mcp add github npx -y mcp-github

# Or using node directly
claude mcp add github node /path/to/packages/mcp-servers/dist/github/server.js
```

Add environment variable to Claude Code:
```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

## Available Tools

### Repository Management

#### `github_get_repo`
Get repository details including description, default branch, and metadata.

Arguments:
- `owner` (string): Repository owner (username or organization)
- `repo` (string): Repository name

Example:
```typescript
{
  "owner": "your-org",
  "repo": "your-repo"
}
```

#### `github_list_branches`
List all branches in a repository.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `protected` (boolean, optional): Filter by protected status

#### `github_create_branch`
Create a new branch from an existing branch.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `branch` (string): Branch name to create
- `from_branch` (string, optional): Source branch (default: "main")

#### `github_delete_branch`
Delete a branch. Protected branches cannot be deleted.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `branch` (string): Branch name to delete

#### `github_get_file_contents`
Get contents of a file or directory. Returns base64-encoded content for files, array of items for directories.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `path` (string): File or directory path
- `ref` (string, optional): Branch, tag, or commit SHA (default: default branch)

#### `github_create_or_update_file`
Create a new file or update an existing file. Content will be base64 encoded automatically.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `path` (string): File path
- `content` (string): File content (will be base64 encoded)
- `message` (string): Commit message
- `branch` (string): Branch name
- `sha` (string, optional): Blob SHA of the file being replaced (required for updates)

### Pull Request Management

#### `github_list_pull_requests`
List pull requests in a repository.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `state` (enum, optional): "open", "closed", or "all" (default: "open")
- `limit` (number, optional): Maximum number of PRs to return (default: 30)

#### `github_get_pull_request`
Get detailed information about a specific pull request.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `pull_number` (number): Pull request number

#### `github_create_pull_request`
Create a new pull request.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `title` (string): PR title
- `body` (string, optional): PR description
- `head` (string): Branch containing changes
- `base` (string): Branch to merge into
- `draft` (boolean, optional): Create as draft PR (default: false)

#### `github_merge_pull_request`
Merge a pull request using specified merge method.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `pull_number` (number): Pull request number
- `merge_method` (enum, optional): "merge", "squash", or "rebase" (default: "merge")
- `commit_title` (string, optional): Custom commit title
- `commit_message` (string, optional): Custom commit message

#### `github_get_pull_request_files`
Get the list of files changed in a pull request with diff stats.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `pull_number` (number): Pull request number

### Issue Management

#### `github_list_issues`
List issues in a repository (excludes pull requests).

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `state` (enum, optional): "open", "closed", or "all" (default: "open")
- `labels` (string, optional): Comma-separated list of label names
- `limit` (number, optional): Maximum number of issues to return (default: 30)

#### `github_get_issue`
Get detailed information about a specific issue.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `issue_number` (number): Issue number

#### `github_create_issue`
Create a new issue with optional labels and assignees.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `title` (string): Issue title
- `body` (string, optional): Issue description
- `labels` (string[], optional): Labels to apply
- `assignees` (string[], optional): Usernames to assign

#### `github_create_issue_comment`
Add a comment to an existing issue or pull request.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `issue_number` (number): Issue number
- `body` (string): Comment body

### Workflow Management

#### `github_list_workflow_runs`
List GitHub Actions workflow runs with optional filters.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `workflow_id` (string, optional): Workflow ID or filename (e.g., "ci.yml")
- `branch` (string, optional): Filter by branch
- `status` (enum, optional): "queued", "in_progress", or "completed"
- `limit` (number, optional): Maximum number of runs to return (default: 20)

#### `github_get_workflow_run`
Get detailed information about a specific workflow run.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `run_id` (number): Workflow run ID

#### `github_rerun_workflow`
Re-run a failed or completed workflow.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `run_id` (number): Workflow run ID

#### `github_cancel_workflow_run`
Cancel a running workflow.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `run_id` (number): Workflow run ID

### Secrets Management

#### `github_create_secret`
Create or update a repository secret for GitHub Actions.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `secret_name` (string): Secret name (uppercase with underscores)
- `secret_value` (string): Secret value to encrypt and store

#### `github_list_secrets`
List all repository secrets (names only, values are never exposed by GitHub).

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name

#### `github_delete_secret`
Delete a repository secret.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `secret_name` (string): Secret name to delete

### Environment Management

#### `github_list_environments`
List deployment environments (e.g., production, staging, preview).

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name

#### `github_create_environment_secret`
Create or update an environment-specific secret.

**Note:** Requires CTO approval via GENTYR protection when targeting production environments.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `environment_name` (string): Environment name (e.g., "production", "staging")
- `secret_name` (string): Secret name (uppercase with underscores)
- `secret_value` (string): Secret value to encrypt and store

#### `github_delete_environment_secret`
Delete an environment-specific secret.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `environment_name` (string): Environment name
- `secret_name` (string): Secret name to delete

### Branch Protection

#### `github_get_branch_protection`
Get branch protection rules for a specific branch.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `branch` (string): Branch name

#### `github_update_branch_protection`
Update branch protection rules (e.g., require PR reviews, status checks).

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `branch` (string): Branch name
- `required_status_checks` (object, optional): Status check configuration
  - `strict` (boolean): Require branches to be up to date
  - `contexts` (string[]): Required status check names
- `enforce_admins` (boolean, optional): Apply rules to administrators
- `required_pull_request_reviews` (object, optional): PR review configuration
  - `required_approving_review_count` (number, 1-6): Number of approvals required
  - `dismiss_stale_reviews` (boolean): Dismiss approvals on new commits
  - `require_code_owner_reviews` (boolean): Require code owner approval
- `restrictions` (object, optional): Push access restrictions
  - `users` (string[]): Usernames with push access
  - `teams` (string[]): Team slugs with push access
- `required_linear_history` (boolean, optional): Require linear history
- `allow_force_pushes` (boolean, optional): Allow force pushes
- `allow_deletions` (boolean, optional): Allow branch deletion

#### `github_delete_branch_protection`
Remove all branch protection rules from a branch.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `owner` (string): Repository owner
- `repo` (string): Repository name
- `branch` (string): Branch name

## Examples

### Create a feature branch and open a PR

```typescript
// Create a new branch
await github_create_branch({
  owner: "your-org",
  repo: "your-repo",
  branch: "feature/new-integration",
  from_branch: "main"
});

// Create or update files
await github_create_or_update_file({
  owner: "your-org",
  repo: "your-repo",
  path: "integrations/newplatform/index.ts",
  content: "export const platform = 'newplatform';",
  message: "Add new platform integration",
  branch: "feature/new-integration"
});

// Create a pull request
await github_create_pull_request({
  owner: "your-org",
  repo: "your-repo",
  title: "Add new platform integration",
  body: "Implements support for new platform",
  head: "feature/new-integration",
  base: "main"
});
```

### Check workflow status

```typescript
// List recent workflow runs
const runs = await github_list_workflow_runs({
  owner: "your-org",
  repo: "your-repo",
  limit: 5
});

// Get details of a failed run
const run = await github_get_workflow_run({
  owner: "your-org",
  repo: "your-repo",
  run_id: runs[0].id
});

// Rerun if needed
await github_rerun_workflow({
  owner: "your-org",
  repo: "your-repo",
  run_id: runs[0].id
});
```

## Architecture

The GitHub MCP server follows the standard MCP server pattern used in this project:

1. **types.ts**: Zod schemas for input validation (G003 compliance) and TypeScript types
2. **server.ts**: MCP server implementation using shared `McpServer` base class
3. **index.ts**: Module exports

All API calls are authenticated using the `GITHUB_TOKEN` environment variable and follow GitHub's REST API v3 conventions.

## Error Handling

The server follows G001 (fail-closed) principles:
- Missing `GITHUB_TOKEN` causes the server to exit with error code 1
- Invalid API responses throw errors with detailed messages
- All input is validated with Zod schemas before processing
- API errors include the HTTP status code and GitHub error message

## Security

- The `GITHUB_TOKEN` is never logged or exposed in responses
- All API calls use HTTPS (GitHub API default)
- Token is sent via `Authorization: Bearer` header (GitHub API standard)
- Input validation prevents injection attacks
- Follows G003 (validate all external input) and G004 (no hardcoded credentials)
