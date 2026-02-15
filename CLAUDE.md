# GENTYR Framework

A modular automation framework for Claude Code.

## Usage

All commands run from the framework directory (`/path/to/gentyr`). Use `--path` to specify the target project.

### Install (with protection - recommended)

```bash
sudo scripts/setup.sh --path /path/to/project --protect
```

Installs framework symlinks, configs, husky hooks, builds MCP servers, and makes critical files root-owned to prevent agent bypass.

### Install (without protection - development only)

```bash
scripts/setup.sh --path /path/to/project
```

### Uninstall

```bash
sudo scripts/setup.sh --path /path/to/project --uninstall
```

Removes protection, symlinks, generated configs, and husky hooks. Preserves runtime state (`.claude/*.db`).

### Protect Only

```bash
sudo scripts/setup.sh --path /path/to/project --protect-only
```

Adds root ownership to critical files without reinstalling.

### Unprotect Only

```bash
sudo scripts/setup.sh --path /path/to/project --unprotect-only
```

Removes root ownership from critical files. Use before making manual changes to protected files, then re-protect with `--protect-only`.

### Verify Installation

```bash
cd /path/to/project && claude mcp list
```

## AI User Feedback System

Configure user personas to automatically test your app when staging changes are detected:

```bash
# In a Claude Code session after GENTYR is installed:
/configure-personas
```

Creates personas (GUI/CLI/API/SDK modes), registers features with file patterns, and maps personas to features. Feedback agents spawn on staging changes and report findings to deputy-CTO triage pipeline.

## Automation Service

```bash
scripts/setup-automation-service.sh status --path /project  # Check service status
scripts/setup-automation-service.sh remove --path /project  # Remove service
scripts/setup-automation-service.sh run --path /project     # Manual run
```
