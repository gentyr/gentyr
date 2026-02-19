#!/usr/bin/env python3
"""
patch-clawd.py — Robust Clawd Mascot Patcher for Claude Code

Replaces the stock Clawd mascot in the Claude Code binary with the #29 Winged Eye
design. Works across Claude Code versions by detecting structural patterns rather
than relying on hardcoded offsets.

Design #29 — Winged Eye:
    ▗▘ ✦ ▝▖    Row 1: wing tips + sparkle (penguinShimmer)
    ▐▌ ● ▐▌    Row 2: wings + pupil (penguinShimmer wings, clawd_body eye)
     ▀   ▀     Row 3: wing bases (chromeYellow)

This is a purely decorative, non-critical feature. If anything unexpected is
detected, the script fails gracefully with a clear message and exit code 0.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys

# ---------------------------------------------------------------------------
# Design constants
# ---------------------------------------------------------------------------

# The #29 Winged Eye replacement templates.
# {react} = React import variable (e.g. x$, mB)
# {flex}  = Flex container component (e.g. P)
# {text}  = Text component (e.g. L)
# Row 1 string: \u2597\u2598 \u2726 \u259D\u2596  (▗▘ ✦ ▝▖)
# Row 2 wing:   \u2590\u258C                       (▐▌)
# Row 2 eye:    " \u25CF "                         ( ● )
# Row 3 feet:   \u2580   \u2580                    ( ▀   ▀ )
#
# Padding is done with empty-string children ,"" (3 bytes each) and trailing
# spaces in Row 3 string (1 byte each) to hit the exact target byte count.

ROW1_STR = r'"\u2597\u2598 \u2726 \u259D\u2596"'
ROW2_WING = r'"\u2590\u258C"'
ROW2_EYE = r'" \u25CF "'
ROW3_BASE = r'" \u2580   \u2580 "'  # base version, may get trailing spaces adjusted

# Color scheme
ROW1_COLOR = "chromeYellow"
ROW2_WING_COLOR = "penguinShimmer"
ROW2_EYE_COLOR = "chromeYellow"
ROW3_COLOR = "chromeYellow"

# ---------------------------------------------------------------------------
# Color output helpers
# ---------------------------------------------------------------------------

_use_color = True


def _c(code, text):
    if not _use_color:
        return text
    return f"\033[{code}m{text}\033[0m"


def info(msg):
    print(_c("36", f"  {msg}"))


def success(msg):
    print(_c("32", f"  {msg}"))


def warn(msg):
    print(_c("33", f"  {msg}"))


def error(msg):
    print(_c("31", f"  {msg}"))


def header(msg):
    print(_c("1;35", f"\n  {msg}"))


# ---------------------------------------------------------------------------
# Binary detection
# ---------------------------------------------------------------------------

def find_claude_binary():
    """Auto-detect the Claude Code binary across common install locations."""
    candidates = []

    # Homebrew cask (most common on macOS)
    homebrew_base = "/opt/homebrew/Caskroom/claude-code"
    if os.path.isdir(homebrew_base):
        for entry in sorted(os.listdir(homebrew_base), reverse=True):
            path = os.path.join(homebrew_base, entry, "claude")
            if os.path.isfile(path):
                candidates.append(path)

    # Intel Homebrew
    intel_base = "/usr/local/Caskroom/claude-code"
    if os.path.isdir(intel_base):
        for entry in sorted(os.listdir(intel_base), reverse=True):
            path = os.path.join(intel_base, entry, "claude")
            if os.path.isfile(path):
                candidates.append(path)

    # which claude (resolve symlinks)
    try:
        result = subprocess.run(
            ["which", "claude"], capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            resolved = os.path.realpath(result.stdout.strip())
            if os.path.isfile(resolved) and resolved not in candidates:
                candidates.append(resolved)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return candidates[0] if candidates else None


def verify_binary_runs(binary_path):
    """Check that the binary executes without error."""
    try:
        result = subprocess.run(
            [binary_path, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0 and result.stdout.strip() != ""
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def codesign_binary(binary_path):
    """Re-sign the binary and clear quarantine (required on macOS after modification)."""
    try:
        # Clear quarantine attributes first (prevents Gatekeeper prompts)
        subprocess.run(
            ["xattr", "-cr", binary_path],
            capture_output=True,
            timeout=10,
        )
        result = subprocess.run(
            ["codesign", "--force", "--sign", "-", binary_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------------------
# Pattern detection — version-agnostic
# ---------------------------------------------------------------------------

# Anchor: flexDirection:"column",alignItems:"center" near clawd_body
ANCHOR = rb'flexDirection:"column",alignItems:"center"'

# Mascot unicode chars that may appear in any version of the mascot.
# Includes stock chars, quadrant blocks used in patched versions, and half blocks.
MASCOT_CHARS = [
    rb"\u25CF",  # ● black circle (eye)
    rb"\u2580",  # ▀ upper half block
    rb"\u258C",  # ▌ left half block
    rb"\u2590",  # ▐ right half block
    rb"\u2584",  # ▄ lower half block
    rb"\u2596",  # ▖ quadrant lower left
    rb"\u2597",  # ▗ quadrant lower right
    rb"\u2598",  # ▘ quadrant upper left
    rb"\u259D",  # ▝ quadrant upper right
    rb"\u2726",  # ✦ black four pointed star
]

# Full function pattern: function NAME(){return VAR.createElement(...)}
# Uses [\w$]+ to match JS identifiers that may contain $ (e.g. $X8, x$)
FULL_FUNC_RE = re.compile(
    rb"function\s+([\w$]+)\(\)\{return\s+([\w$]+(?:\.[\w$]+)?)\."
    rb"createElement\(([\w$]+),\{flexDirection:\"column\",alignItems:\"center\"\}"
)

# Return-block pattern: return VAR.createElement(COMP,{flexDirection...})
RETURN_BLOCK_RE = re.compile(
    rb"return\s+([\w$]+(?:\.[\w$]+)?)\."
    rb"createElement\(([\w$]+),\{flexDirection:\"column\",alignItems:\"center\"\}"
)


def _extract_block(data, start_offset, kind):
    """Extract a brace/paren-balanced block starting at start_offset.

    kind='function' tracks {}, kind='return' tracks () from first (.
    Returns (block_bytes, length) or (None, 0).
    """
    if kind == "function":
        open_c, close_c = ord("{"), ord("}")
    else:
        open_c, close_c = ord("("), ord(")")

    depth = 0
    started = False
    end = 0

    # For function blocks, start from the function keyword
    # For return blocks, we need to find the first open paren
    chunk_size = 2000  # generous upper bound
    chunk = data[start_offset : start_offset + chunk_size]

    if kind == "function":
        # Track braces
        for i in range(len(chunk)):
            b = chunk[i]
            if b == open_c:
                depth += 1
                started = True
            elif b == close_c:
                depth -= 1
                if started and depth == 0:
                    end = i + 1
                    break
        if end == 0:
            return None, 0
        return bytes(chunk[:end]), end
    else:
        # For return blocks: start is at 'return', end at matching close paren
        paren_depth = 0
        paren_started = False
        for i in range(len(chunk)):
            b = chunk[i]
            if b == ord("("):
                paren_depth += 1
                paren_started = True
            elif b == ord(")"):
                paren_depth -= 1
                if paren_started and paren_depth == 0:
                    end = i + 1
                    break
        if end == 0:
            return None, 0
        return bytes(chunk[:end]), end


def find_mascot_blocks(data):
    """Find all mascot function/return blocks in the binary.

    Returns a list of dicts:
        {
            'kind': 'full_function' | 'return_block',
            'offset': int,
            'length': int,
            'block': bytes,
            'func_name': str or None,
            'react_var': str,
            'flex_var': str,
            'text_var': str,
        }
    """
    blocks = []

    # Strategy 1: Find full function definitions
    for m in FULL_FUNC_RE.finditer(data):
        func_name = m.group(1).decode("ascii")
        react_var = m.group(2).decode("ascii")
        flex_var = m.group(3).decode("ascii")
        func_start = m.start()

        # Validate: clawd_body must be nearby
        context = data[func_start : func_start + 600]
        if b"clawd_body" not in context:
            continue

        # Must have at least one mascot unicode char nearby
        has_mascot_char = any(c in context for c in MASCOT_CHARS)
        if not has_mascot_char:
            continue

        # Extract full block
        block_bytes, block_len = _extract_block(data, func_start, "function")
        if block_bytes is None:
            continue

        # Find the text component variable (L in the stock code)
        # It's the component used in createElement(X,{color:"clawd_body"})
        text_match = re.search(
            rb"createElement\(([\w$]+),\{color:\"clawd_body\"",
            block_bytes,
        )
        if text_match is None:
            # Try penguinShimmer (our replacement color for row 1)
            text_match = re.search(
                rb"createElement\(([\w$]+),\{color:\"penguinShimmer\"",
                block_bytes,
            )
        if text_match is None:
            # Try: the null variant createElement(X,null,
            text_match = re.search(
                rb"createElement\(([\w$]+),null,",
                block_bytes,
            )
        if text_match is None:
            continue

        text_var = text_match.group(1).decode("ascii")

        blocks.append(
            {
                "kind": "full_function",
                "offset": func_start,
                "length": block_len,
                "block": block_bytes,
                "func_name": func_name,
                "react_var": react_var,
                "flex_var": flex_var,
                "text_var": text_var,
            }
        )

    # Strategy 2: Find return-block patterns (inside larger functions)
    for m in RETURN_BLOCK_RE.finditer(data):
        react_var = m.group(1).decode("ascii")
        flex_var = m.group(2).decode("ascii")
        return_start = m.start()

        # Skip if this offset is already inside a full_function block
        inside_full = False
        for fb in blocks:
            if fb["offset"] <= return_start < fb["offset"] + fb["length"]:
                inside_full = True
                break
        if inside_full:
            continue

        # Validate: clawd_body must be nearby
        context = data[return_start : return_start + 600]
        if b"clawd_body" not in context:
            continue

        has_mascot_char = any(c in context for c in MASCOT_CHARS)
        if not has_mascot_char:
            continue

        # Extract return block
        block_bytes, block_len = _extract_block(data, return_start, "return")
        if block_bytes is None:
            continue

        # Find text component variable
        text_match = re.search(
            rb"createElement\(([\w$]+),\{color:\"clawd_body\"",
            block_bytes,
        )
        if text_match is None:
            text_match = re.search(
                rb"createElement\(([\w$]+),\{color:\"penguinShimmer\"",
                block_bytes,
            )
        if text_match is None:
            text_match = re.search(
                rb"createElement\(([\w$]+),null,",
                block_bytes,
            )
        if text_match is None:
            continue

        text_var = text_match.group(1).decode("ascii")

        blocks.append(
            {
                "kind": "return_block",
                "offset": return_start,
                "length": block_len,
                "block": block_bytes,
                "func_name": None,
                "react_var": react_var,
                "flex_var": flex_var,
                "text_var": text_var,
            }
        )

    return blocks


# ---------------------------------------------------------------------------
# Replacement builder
# ---------------------------------------------------------------------------

# Fingerprint: our patched version has chromeYellow Row 1 with the sparkle char
PATCHED_FINGERPRINT = rb'color:"chromeYellow"},"\u2597\u2598 \u2726 \u259D\u2596"'


def is_already_patched(block_bytes):
    """Check if a block already contains our #29 Winged Eye replacement."""
    return PATCHED_FINGERPRINT in block_bytes


def build_replacement(block_info):
    """Build the #29 Winged Eye replacement for a detected block.

    Returns (replacement_bytes, ok, message).
    """
    react = block_info["react_var"]
    flex = block_info["flex_var"]
    text = block_info["text_var"]
    kind = block_info["kind"]
    target_len = block_info["length"]

    # Build the core replacement (without padding)
    # Row 1: wing tips + sparkle
    row1 = (
        f'{react}.createElement({text},{{color:"{ROW1_COLOR}"}},'
        f'{ROW1_STR})'
    )
    # Row 2: wings flanking eye
    row2_left = f'{react}.createElement({text},{{color:"{ROW2_WING_COLOR}"}},{ROW2_WING})'
    row2_eye = f'{react}.createElement({text},{{color:"{ROW2_EYE_COLOR}"}},{ROW2_EYE})'
    row2_right = f'{react}.createElement({text},{{color:"{ROW2_WING_COLOR}"}},{ROW2_WING})'
    row2 = f'{react}.createElement({text},null,{row2_left},{row2_eye},{row2_right})'
    # Row 3: wing bases
    row3 = f'{react}.createElement({text},{{color:"{ROW3_COLOR}"}},{ROW3_BASE})'

    # Assemble
    inner = f'{react}.createElement({flex},{{flexDirection:"column",alignItems:"center"}},{row1},{row2},{row3})'

    if kind == "full_function":
        func_name = block_info["func_name"]
        core = f"function {func_name}(){{return {inner}}}"
    else:
        core = f"return {inner}"

    core_bytes = core.encode("ascii")
    core_len = len(core_bytes)
    delta = target_len - core_len

    if delta < 0:
        return None, False, f"Replacement is {-delta} bytes too long ({core_len} > {target_len})"

    if delta == 0:
        return core_bytes, True, "Exact fit, no padding needed"

    # Padding strategy:
    # 1. Add empty string children ,"" to Row 1 (3 bytes each)
    # 2. If remainder after dividing by 3, adjust Row 3 trailing spaces

    # First, try adjusting Row 3 string to absorb remainder
    remainder = delta % 3
    padding_count = delta // 3

    if remainder == 1:
        # Add 1 extra trailing space to Row 3 string
        row3_str = r'" \u2580   \u2580  "'  # +1 space
        row3 = f'{react}.createElement({text},{{color:"{ROW3_COLOR}"}},{row3_str})'
        inner = f'{react}.createElement({flex},{{flexDirection:"column",alignItems:"center"}},{row1},{row2},{row3})'
        if kind == "full_function":
            core = f"function {block_info['func_name']}(){{return {inner}}}"
        else:
            core = f"return {inner}"
        core_bytes = core.encode("ascii")
        delta = target_len - len(core_bytes)
        padding_count = delta // 3
        remainder = delta % 3
    elif remainder == 2:
        # Add 2 extra trailing spaces to Row 3 string
        row3_str = r'" \u2580   \u2580   "'  # +2 spaces
        row3 = f'{react}.createElement({text},{{color:"{ROW3_COLOR}"}},{row3_str})'
        inner = f'{react}.createElement({flex},{{flexDirection:"column",alignItems:"center"}},{row1},{row2},{row3})'
        if kind == "full_function":
            core = f"function {block_info['func_name']}(){{return {inner}}}"
        else:
            core = f"return {inner}"
        core_bytes = core.encode("ascii")
        delta = target_len - len(core_bytes)
        padding_count = delta // 3
        remainder = delta % 3

    if remainder != 0:
        return (
            None,
            False,
            f"Cannot achieve exact padding: {delta} remaining after core, "
            f"remainder {remainder} after {padding_count} empty strings",
        )

    if padding_count < 0:
        return None, False, f"Replacement is {-delta} bytes too long after adjustments"

    # Insert empty string padding into Row 1: ,"" repeated padding_count times
    padding = ',""' * padding_count
    # Re-build Row 1 with padding inserted before the closing paren
    row1 = (
        f'{react}.createElement({text},{{color:"{ROW1_COLOR}"}},'
        f'{ROW1_STR}{padding})'
    )
    inner = f'{react}.createElement({flex},{{flexDirection:"column",alignItems:"center"}},{row1},{row2},{row3})'

    if kind == "full_function":
        replacement = f"function {block_info['func_name']}(){{return {inner}}}"
    else:
        replacement = f"return {inner}"

    replacement_bytes = replacement.encode("ascii")

    if len(replacement_bytes) != target_len:
        return (
            None,
            False,
            f"Final size mismatch: {len(replacement_bytes)} != {target_len} "
            f"(delta {len(replacement_bytes) - target_len})",
        )

    return replacement_bytes, True, f"Padded with {padding_count} empty strings"


# ---------------------------------------------------------------------------
# Backup management
# ---------------------------------------------------------------------------

def backup_path(binary_path):
    return binary_path + ".bak"


def create_backup(binary_path):
    """Create a backup of the binary if one doesn't already exist."""
    bak = backup_path(binary_path)
    if os.path.exists(bak):
        return True, "Backup already exists"
    try:
        shutil.copy2(binary_path, bak)
        return True, f"Created backup at {bak}"
    except OSError as e:
        return False, f"Failed to create backup: {e}"


def restore_backup(binary_path):
    """Restore the binary from backup."""
    bak = backup_path(binary_path)
    if not os.path.exists(bak):
        return False, "No backup file found"
    try:
        shutil.copy2(bak, binary_path)
        return True, "Restored from backup"
    except OSError as e:
        return False, f"Failed to restore: {e}"


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Patch the Clawd mascot in the Claude Code binary with the #29 Winged Eye design."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Detect and report what would be patched, but don't write",
    )
    parser.add_argument(
        "--restore",
        action="store_true",
        help="Restore binary from backup",
    )
    parser.add_argument(
        "--binary",
        type=str,
        default=None,
        help="Override binary path (default: auto-detect)",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored output",
    )
    args = parser.parse_args()

    global _use_color
    if args.no_color or not sys.stdout.isatty():
        _use_color = False

    header("Clawd Mascot Patcher — #29 Winged Eye")
    print()

    # --- Gate 1: Find binary ---
    binary = args.binary or find_claude_binary()
    if binary is None:
        error("Could not find Claude Code binary.")
        info("Use --binary PATH to specify it manually.")
        return 0

    info(f"Binary: {binary}")

    if not os.path.isfile(binary):
        error(f"Binary not found at {binary}")
        return 0

    if not os.access(binary, os.R_OK):
        error(f"Binary is not readable: {binary}")
        return 0

    # --- Handle --restore ---
    if args.restore:
        header("Restoring from backup")
        ok, msg = restore_backup(binary)
        if not ok:
            error(msg)
            return 0
        success(msg)

        # Re-sign
        info("Re-signing binary...")
        if codesign_binary(binary):
            success("Binary re-signed successfully")
        else:
            warn("codesign failed — binary may not run on macOS")

        # Verify
        if verify_binary_runs(binary):
            success("Binary runs correctly after restore")
        else:
            warn("Binary verification failed after restore")

        return 0

    # --- Gate 2: Binary runs ---
    info("Verifying binary runs...")
    if not verify_binary_runs(binary):
        error("Binary fails to run (claude --version failed).")
        info("The binary may already be corrupted. Try --restore if a backup exists.")
        return 0
    success("Binary runs OK")

    # --- Read binary ---
    info("Reading binary...")
    with open(binary, "rb") as f:
        data = f.read()
    info(f"Binary size: {len(data):,} bytes")

    # --- Gate 3: Find mascot blocks ---
    header("Detecting mascot blocks")
    blocks = find_mascot_blocks(data)

    if not blocks:
        error("No mascot blocks detected in the binary.")
        info("This binary may have an unexpected structure (new version?).")
        return 0

    # Report what we found
    already_patched = 0
    needs_patch = 0
    for b in blocks:
        kind_label = "function" if b["kind"] == "full_function" else "return"
        patched = is_already_patched(b["block"])
        status = "already patched" if patched else "stock/unrecognized"
        if patched:
            already_patched += 1
        else:
            needs_patch += 1
        info(
            f"  [{kind_label:8}] offset {b['offset']:>12,}  "
            f"{b['length']:>4} bytes  "
            f"react={b['react_var']:>4}  flex={b['flex_var']}  text={b['text_var']}  "
            f"— {status}"
        )

    print()
    info(f"Found {len(blocks)} blocks: {already_patched} already patched, {needs_patch} to patch")

    if needs_patch == 0:
        success("All blocks are already patched! Nothing to do.")
        return 0

    # --- Gate 4: Build replacements ---
    header("Building replacements")
    patches = []  # list of (offset, length, old_bytes, new_bytes)

    for b in blocks:
        if is_already_patched(b["block"]):
            continue

        replacement, ok, msg = build_replacement(b)
        if not ok:
            error(f"Cannot build replacement for block at offset {b['offset']:,}: {msg}")
            info("Aborting — no changes made.")
            return 0

        kind_label = "function" if b["kind"] == "full_function" else "return"
        info(f"  [{kind_label:8}] offset {b['offset']:>12,}: {msg}")
        patches.append((b["offset"], b["length"], b["block"], replacement))

    # --- Gate 5: Verify all replacements are exact same byte length ---
    for offset, length, old, new in patches:
        if len(new) != length:
            error(
                f"Size mismatch at offset {offset:,}: "
                f"original {length} bytes, replacement {len(new)} bytes"
            )
            info("Aborting — no changes made.")
            return 0

    success(f"All {len(patches)} replacements verified (exact byte match)")

    # --- Gate 6: No overlaps ---
    sorted_patches = sorted(patches, key=lambda p: p[0])
    for i in range(len(sorted_patches) - 1):
        end_i = sorted_patches[i][0] + sorted_patches[i][1]
        start_next = sorted_patches[i + 1][0]
        if end_i > start_next:
            error(
                f"Overlapping patches: offset {sorted_patches[i][0]:,} "
                f"(ends at {end_i:,}) overlaps with offset {start_next:,}"
            )
            info("Aborting — no changes made.")
            return 0

    # --- Dry run report ---
    if args.dry_run:
        header("Dry run complete")
        info(f"Would patch {len(patches)} blocks in {binary}")
        for offset, length, old, new in patches:
            info(f"  offset {offset:>12,}: {length} bytes")
        print()
        info("Run without --dry-run to apply patches.")
        return 0

    # --- Backup (best-effort, not a gate) ---
    header("Backup")
    ok, msg = create_backup(binary)
    if ok:
        info(msg)
    else:
        warn(f"Backup failed: {msg}")
        warn("Proceeding without backup")

    # --- Apply patches ---
    header("Applying patches")
    modified = bytearray(data)
    for offset, length, old, new in patches:
        # Final safety: verify the bytes at this offset still match
        actual = bytes(modified[offset : offset + length])
        if actual != old:
            error(f"Unexpected content at offset {offset:,} — binary may have changed.")
            info("Aborting — no changes written.")
            return 0

        modified[offset : offset + length] = new
        info(f"  Patched offset {offset:>12,} ({length} bytes)")

    # Verify total size unchanged
    if len(modified) != len(data):
        error(f"Binary size changed: {len(data):,} -> {len(modified):,}")
        info("Aborting — no changes written.")
        return 0

    # Write atomically via temp file + rename (prevents truncation on failure)
    temp_path = binary + ".tmp"
    try:
        with open(temp_path, "wb") as f:
            f.write(modified)
        # Preserve original file permissions (especially the execute bit)
        shutil.copymode(binary, temp_path)
        os.rename(temp_path, binary)
        success("Binary written successfully")
    except OSError as e:
        error(f"Failed to write binary: {e}")
        # Clean up temp file if it exists
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        info("Original binary is untouched.")
        return 0

    # --- Gate 8: Re-sign ---
    info("Re-signing binary...")
    if not codesign_binary(binary):
        warn("codesign failed — attempting to restore from backup")
        ok, msg = restore_backup(binary)
        if ok:
            success(msg)
            codesign_binary(binary)
            if verify_binary_runs(binary):
                success("Backup restored and verified")
            else:
                error("Backup restoration also failed — manual intervention needed")
        else:
            error(msg)
        return 0
    success("Binary re-signed")

    # --- Gate 9: Verify binary still runs ---
    info("Verifying binary runs after patching...")
    if not verify_binary_runs(binary):
        error("Binary verification failed after patching!")
        info("Restoring from backup...")
        ok, msg = restore_backup(binary)
        if ok:
            success(msg)
            codesign_binary(binary)
            if verify_binary_runs(binary):
                success("Backup restored and verified")
            else:
                error("Backup restoration also failed — manual intervention needed")
        else:
            error(msg)
        return 0

    success("Binary runs correctly after patching")

    # --- Summary ---
    header("Done!")
    success(f"Patched {len(patches)} mascot blocks with #29 Winged Eye design")
    info("Launch 'claude' to see the new mascot.")
    print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
