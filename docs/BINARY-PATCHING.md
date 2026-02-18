# Claude Code Binary Patching — Clawd Mascot

Binary patching guide for customizing the Clawd mascot in the Claude Code CLI.

## Architecture

The Claude Code binary (`/opt/homebrew/Caskroom/claude-code/2.1.34/claude`) is a Bun-compiled executable containing embedded JavaScript source text. Bun parses this source at runtime, so any valid JS of the same byte length executes correctly. The UTF-16LE bytecode section (~88MB offset) is unused — only the ASCII source text matters.

### Key Constraint

**Every replacement must be the exact same byte count as the original.** The binary's structure depends on fixed offsets — changing the length corrupts everything downstream.

## Mascot Function Locations

The mascot is rendered by React (Ink) createElement calls. There are multiple copies due to code duplication in the bundle:

| Function | Import | Offset 1 | Offset 2 | Bytes |
|----------|--------|----------|----------|-------|
| `$X8` (full function) | `x$.createElement` | 68,029,279 | 162,119,939 | 454 |
| `CX8` (return block) | `mB.createElement` | 68,036,826 | 162,127,486 | 438 |
| Large variant | `uA.default.createElement` | — | — | varies |

The x$ and mB variants render in Apple Terminal. The large variant renders in non-Apple terminals (wider layout, animated). The `uA.default.createElement` version is the welcome/splash screen.

### Finding Offsets for New Versions

Offsets change with each Claude Code release. To find them:

```python
with open('claude', 'rb') as f:
    data = f.read()

# Find $X8 function
pattern = b'function $X8'
start = 0
while True:
    idx = data.find(pattern, start)
    if idx == -1: break
    print(f"Offset {idx}: {data[idx:idx+100]}")
    start = idx + 1

# Find mB.createElement return
pattern = b'return mB.createElement(P,{flexDirection'
# ... same loop
```

## Theme Colors

Ink uses a theme system — only registered color names work in element props. Raw hex values (e.g., `#B8860B`) resolve to black/default. Available colors relevant to the mascot:

| Name | Chars | Value | Notes |
|------|-------|-------|-------|
| `clawd_body` | 10 | rgb(255,200,50) | Bright gold — the primary mascot color |
| `clawd_background` | 16 | rgb(0,0,0) | Black / terminal background |
| `chromeYellow` | 12 | rgb(251,188,4) | Deeper amber gold |
| `penguin` | 7 | rgb(255,106,0) | Vivid orange |
| `penguinShimmer` | 14 | rgb(255,150,50) | Light warm orange |
| `professionalBlue` | 16 | rgb(106,155,204) | Blue |

Theme definitions are at ~offset 61,827,412 in the binary. The `clawd_body` color was previously patched from the default to `rgb(255,200,50)`.

### Color Name Length Matters

When swapping color names in element props, the replacement must account for character count differences:

- Same length: direct swap (e.g., `clawd_background` (16) ↔ `professionalBlue` (16))
- Different length: compensate elsewhere in the function body

## Byte-Count Compensation Techniques

### Empty String Padding

React/Ink ignores empty string children. Add `,"",""` (6 bytes) or individual `,""` (3 bytes each) as invisible padding:

```javascript
// Original (no padding)
x$.createElement(L,{color:"clawd_body"},"content")
// +6 bytes padded
x$.createElement(L,{color:"clawd_body"},"content","","")
```

### String Content Adjustment

Trailing/leading spaces in strings with only `color` (no `backgroundColor`) are invisible in the terminal. Safe to add/remove for ±1 byte each:

```javascript
// 7 visible chars + 2 invisible padding spaces = 9 bytes
" \u2580   \u2580 "
// 5 visible chars, 0 padding = 5 bytes (centers via flexbox)
"\u2580   \u2580"
```

**Caution**: This changes the string width, which affects `alignItems:"center"` centering relative to other rows.

## Current Design: #29 Winged Eye

```
▗▘ ✦ ▝▖       Row 1: wing tips + sparkle (clawd_body — bright gold)
▐▌ ● ▐▌       Row 2: wings flanking pupil (wings: clawd_body, pupil: clawd_body on clawd_body bg)
 ▀   ▀        Row 3: wing bases (chromeYellow — amber gold)
```

### x$ Version (454 bytes)

```javascript
function $X8(){return x$.createElement(P,{flexDirection:"column",alignItems:"center"},
  x$.createElement(L,{color:"clawd_body"},"\u2597\u2598 \u2726 \u259D\u2596","","","",""),
  x$.createElement(L,null,
    x$.createElement(L,{color:"clawd_body"},"\u2590\u258C"),
    x$.createElement(L,{color:"clawd_body",backgroundColor:"clawd_body"}," \u25CF "),
    x$.createElement(L,{color:"clawd_body"},"\u2590\u258C")),
  x$.createElement(L,{color:"chromeYellow"},"\u2580   \u2580"))}
```

### mB Version (438 bytes)

```javascript
return mB.createElement(P,{flexDirection:"column",alignItems:"center"},
  mB.createElement(L,{color:"clawd_body"},"\u2597\u2598 \u2726 \u259D\u2596","","","",""),
  mB.createElement(L,null,
    mB.createElement(L,{color:"clawd_body"},"\u2590\u258C"),
    mB.createElement(L,{color:"clawd_body",backgroundColor:"clawd_body"}," \u25CF "),
    mB.createElement(L,{color:"clawd_body"},"\u2590\u258C")),
  mB.createElement(L,{color:"chromeYellow"},"\u2580   \u2580"))
```

### Unicode Character Reference

| Char | Code | Name |
|------|------|------|
| ▗ | \u2597 | Quadrant lower right |
| ▘ | \u2598 | Quadrant upper left |
| ✦ | \u2726 | Black four pointed star |
| ▝ | \u259D | Quadrant upper right |
| ▖ | \u2596 | Quadrant lower left |
| ▐ | \u2590 | Right half block |
| ▌ | \u258C | Left half block |
| ● | \u25CF | Black circle |
| ▀ | \u2580 | Upper half block |
| ▄ | \u2584 | Lower half block (original eyelid) |

## Patching Workflow

```bash
# 1. Backup (once)
cp /opt/homebrew/Caskroom/claude-code/2.1.34/claude \
   /opt/homebrew/Caskroom/claude-code/2.1.34/claude.bak

# 2. Apply patches (Python — handles binary safely)
python3 patch-clawd.py

# 3. Re-sign (required on macOS)
codesign --force --sign - /opt/homebrew/Caskroom/claude-code/2.1.34/claude

# 4. Verify
claude --version   # Should print version without error
claude             # Visual check
```

### Rollback

```bash
cp /opt/homebrew/Caskroom/claude-code/2.1.34/claude.bak \
   /opt/homebrew/Caskroom/claude-code/2.1.34/claude
```

## Why Multi-Char Strings Work (and Single-Char Slots Don't)

The original mascot structure uses individual single-character children for each visual element. Bun's bundler **deduplicates identical single-character strings** — so if the left arm and left eye use the same `\uXXXX` code, they share the same string reference. This makes it impossible to give them different characters.

Multi-character strings (e.g., `"\u2597\u2598 \u2726 \u259D\u2596"`) are unique and avoid deduplication. Writing each row as a single string with all its characters gives full per-row visual control.

## Lessons Learned

1. **Hex colors don't work** — Ink's theme system only resolves registered names, not raw `#RRGGBB` values. A hex backgroundColor renders as black/default.
2. **The UTF-16LE bytecode section is ignored** — Bun re-parses the embedded ASCII source text. Only patch the source copies.
3. **Each function exists twice** — at ~68MB and ~162MB. Both must be patched.
4. **codesign is mandatory** — macOS rejects unsigned modified binaries.
5. **Empty string children are free padding** — React ignores them, giving reliable ±3 byte increments.
6. **Trailing spaces are invisible** — in elements with `color` but no `backgroundColor`, spaces have no visible effect (but do affect centering width).
