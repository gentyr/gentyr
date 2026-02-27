# Remove Account from Rotation

Interactive command to remove an account from the rotation system.

## Steps

### Step 1: Read current rotation state

Use the Bash tool to list registered accounts:

```bash
npx gentyr remove-account --list
```

Display the accounts table to the user.

### Step 2: Ask which account to remove

Use `AskUserQuestion` to ask the user which account they want to remove. List each email as an option. If there's only one account, still confirm.

### Step 3: Confirm removal

Use `AskUserQuestion` to confirm:
- "Are you sure you want to remove **{email}** from rotation?"
- Options: "Yes, remove it", "Cancel"

If the account is the active account AND it's the only account, warn that `--force` will be needed and there will be no active account after removal.

### Step 4: Execute removal

Run the CLI command:

```bash
npx gentyr remove-account "<email>" [--force]
```

Use `--force` only if the user confirmed removal of the last account in Step 3.

### Step 5: Display updated state

Re-read and display the updated account list to confirm the removal took effect:

```bash
npx gentyr remove-account --list
```
