#!/usr/bin/env python3
"""
Binary Patch Research: Claude Code credential memoization (iB/oR) TTL injection.

Claude Code caches OAuth credentials in memory via iB = oR(() => { ... }),
where oR() is a lazy-singleton memoization wrapper. The cache is only cleared by:
  - SRA() — proactive refresh, fires at ~5 min before token expiry (jv())
  - r6T() — 401 recovery, fires on HTTP 401 response
  - XFT() — after saving new OAuth tokens

For QUOTA rotation (GENTYR switches to a different account while the old token
is still valid), neither mechanism fires. The old token has hours of life left,
so SRA() doesn't trigger, and the API returns 429 (not 401) so r6T() doesn't
fire either. Result: Claude Code keeps using the old (exhausted) account's
cached token until it naturally expires.

TARGET: Patch oR() to add TTL-based cache invalidation (~60 seconds). After the
TTL expires, the next iB() call re-reads from Keychain, picking up any new
credentials written by GENTYR's rotation hooks.

BINARY STRUCTURE (v2.1.34):
  - Format: Bun SEA (Single Executable Application), Mach-O arm64
  - Size: ~180MB
  - JS is embedded as a single minified bundle
  - Key symbols (minified names, version-specific):
    - oR    : memoization wrapper function (lazy singleton pattern)
    - iB    : memoized OAuth credential reader (iB = oR(() => { ... }))
    - jV    : keychain cache state { data, valid }
    - El()  : clears jV (keychain cache invalidation)
    - jv()  : checks if token is approaching expiry
    - SRA() : proactive token refresh
    - r6T() : 401 recovery handler
    - nLD() : calls iB.cache?.clear?.() + El()

DRY-RUN ONLY. This script searches for patterns and reports what it would change.
Run with --dry-run (default) to analyze. No writes without --apply.

Usage:
    python3 scripts/patch-credential-cache.py --dry-run [--binary /path/to/claude]
"""

import argparse
import os
import re
import struct
import sys
from pathlib import Path


def find_claude_binary():
    """Find the Claude Code binary."""
    candidates = [
        os.path.expanduser("~/.claude/local/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ]
    for c in candidates:
        real = os.path.realpath(c)
        if os.path.isfile(real):
            return real
    return None


def search_patterns(data: bytes):
    """Search for key patterns in the binary's embedded JS bundle."""
    results = {}

    # Pattern 1: oR memoization function definition
    # Looking for the assignment pattern where oR is set to a function
    pat_or_assign = rb'oR=([a-zA-Z0-9_$]+)='
    matches = list(re.finditer(pat_or_assign, data))
    results['oR_assignment'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:5]]

    # Pattern 2: iB = oR(() => { ... }) assignment
    pat_ib = rb'iB=oR\(\(\)=>\{'
    matches = list(re.finditer(pat_ib, data))
    results['iB_assignment'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:5]]

    # Pattern 3: iB.cache?.clear?.() calls — these are the cache invalidation points
    pat_cache_clear = rb'iB\.cache\?\.\s*clear\?\.\(\)'
    matches = list(re.finditer(pat_cache_clear, data))
    results['iB_cache_clear'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:20]]

    # Pattern 4: The nLD function that clears both iB and jV caches
    pat_nld = rb'function nLD\(\)\{iB\.cache'
    matches = list(re.finditer(pat_nld, data))
    results['nLD_function'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:5]]

    # Pattern 5: SRA function — proactive refresh
    pat_sra = rb'async function SRA\('
    matches = list(re.finditer(pat_sra, data))
    results['SRA_function'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:5]]

    # Pattern 6: r6T function — 401 recovery
    pat_r6t = rb'async function r6T\('
    matches = list(re.finditer(pat_r6t, data))
    results['r6T_function'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:5]]

    # Pattern 7: jv function — expiry check (used by SRA)
    # jv is called as jv(_.expiresAt) or jv(q.expiresAt)
    pat_jv_call = rb'jv\([a-zA-Z_$]+\.expiresAt\)'
    matches = list(re.finditer(pat_jv_call, data))
    results['jv_calls'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:10]]

    # Pattern 8: The El() function — keychain cache invalidation
    pat_el = rb'function El\(\)\{jV='
    matches = list(re.finditer(pat_el, data))
    results['El_function'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:5]]

    # Pattern 9: yW().read() — the actual keychain/file read that iB delegates to
    pat_yw = rb'yW\(\)\.read\(\)'
    matches = list(re.finditer(pat_yw, data))
    results['yW_read'] = [(m.start(), m.group().decode('utf-8', errors='replace')) for m in matches[:10]]

    return results


def analyze_or_function(data: bytes, offset: int):
    """Extract and analyze the oR memoization function around the given offset."""
    # Get surrounding context (500 bytes before and after)
    start = max(0, offset - 200)
    end = min(len(data), offset + 500)
    context = data[start:end].decode('utf-8', errors='replace')
    return context


def propose_patch(data: bytes, results: dict):
    """Propose a TTL patch for the oR memoization function.

    Strategy: Instead of patching oR itself (risky, affects all memoized functions),
    patch the iB assignment to wrap the result with TTL logic.

    Current:  iB=oR(()=>{...})
    Patched:  iB=(()=>{let _c=null,_t=0;return()=>{if(_c&&Date.now()<_t)return _c;_c=oR(()=>{...})();return _c}})()

    Problem: This changes byte count significantly. Alternative approaches:

    Approach A (preferred): Inject a setInterval that periodically clears iB.cache.
    Find a suitable injection point near module initialization and add:
      setInterval(()=>{iB.cache?.clear?.()},60000)
    This is 46 bytes. We need to find 46 bytes of padding or expendable code.

    Approach B: Patch the oR function itself to add TTL. The oR wrapper likely
    stores the result in a .cache property. We'd modify the cache check to include
    a timestamp comparison.

    Approach C: Patch jv() to use a much larger buffer (e.g., 4 hours instead of
    5 minutes), so SRA fires much sooner. REJECTED per user feedback.
    """
    proposals = []

    # Check if we found the key patterns
    if not results.get('iB_cache_clear'):
        proposals.append({
            'type': 'ERROR',
            'detail': 'Could not find iB.cache?.clear?.() pattern — binary may be obfuscated differently',
        })
        return proposals

    if not results.get('iB_assignment'):
        proposals.append({
            'type': 'ERROR',
            'detail': 'Could not find iB=oR(()=>{ assignment — symbol names may have changed',
        })
        return proposals

    # Approach A: Find injection point for setInterval
    # Look for the end of the H_ module initialization (where iB is defined)
    # The pattern "CFT=null" appears right after iB definition
    pat_cft = rb'CFT=null'
    cft_matches = list(re.finditer(pat_cft, data))

    if cft_matches:
        # Find the one near iB assignment
        ib_offset = results['iB_assignment'][0][0]
        nearest = min(cft_matches, key=lambda m: abs(m.start() - ib_offset))

        if abs(nearest.start() - ib_offset) < 5000:
            # Good — CFT=null is near iB. We can inject after it.
            inject_offset = nearest.start() + len(nearest.group())

            # The injection: ,setInterval(()=>{iB.cache?.clear?.()},6e4)
            # This is 49 bytes. We'd need to find 49 bytes to replace.
            injection = b',setInterval(()=>{iB.cache?.clear?.()},6e4)'

            proposals.append({
                'type': 'APPROACH_A',
                'detail': f'Inject periodic cache clear after CFT=null at offset {nearest.start()}',
                'injection': injection.decode('utf-8'),
                'injection_bytes': len(injection),
                'offset': inject_offset,
                'context': data[max(0, nearest.start()-50):nearest.start()+100].decode('utf-8', errors='replace'),
                'feasibility': 'MEDIUM — requires finding expendable bytes or expanding the segment',
            })

    # Approach B: Examine the oR function for TTL injection
    if results.get('oR_assignment'):
        or_offset = results['oR_assignment'][0][0]
        or_context = analyze_or_function(data, or_offset)

        proposals.append({
            'type': 'APPROACH_B',
            'detail': f'Patch oR function at offset {or_offset} to add TTL check',
            'context_preview': or_context[:300],
            'feasibility': 'LOW — oR is used by multiple functions, TTL would affect all',
        })

    # Summary
    proposals.append({
        'type': 'RECOMMENDATION',
        'detail': (
            'Approach A (setInterval injection) is the safest path. '
            'It adds a 60-second periodic cache clear for iB only, '
            'without modifying the memoization infrastructure. '
            'The injection site (after CFT=null in the H_ module init) '
            'is executed once at startup. '
            'Requires either: (1) finding dead bytes to overwrite, '
            '(2) expanding the JS bundle section, or '
            '(3) shortening an adjacent string literal to make room.'
        ),
    })

    return proposals


def main():
    parser = argparse.ArgumentParser(description='Claude Code credential cache binary patch research')
    parser.add_argument('--dry-run', action='store_true', default=True,
                        help='Analyze only, do not modify (default)')
    parser.add_argument('--binary', type=str, default=None,
                        help='Path to Claude Code binary (auto-detected if omitted)')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Show detailed pattern match context')
    args = parser.parse_args()

    # Find binary
    binary_path = args.binary or find_claude_binary()
    if not binary_path:
        print("ERROR: Could not find Claude Code binary. Use --binary to specify path.")
        sys.exit(1)

    print(f"=== Claude Code Credential Cache Patch Research ===")
    print(f"Binary: {binary_path}")
    print(f"Size: {os.path.getsize(binary_path) / 1024 / 1024:.1f} MB")
    print(f"Mode: {'DRY-RUN (analysis only)' if args.dry_run else 'APPLY (DANGEROUS)'}")
    print()

    # Read binary
    print("Reading binary...")
    with open(binary_path, 'rb') as f:
        data = f.read()
    print(f"Read {len(data)} bytes")
    print()

    # Search for patterns
    print("=== Pattern Search ===")
    results = search_patterns(data)

    for pattern_name, matches in results.items():
        if matches:
            print(f"  {pattern_name}: {len(matches)} match(es)")
            for offset, text in matches[:3]:
                preview = text[:80]
                print(f"    offset={offset} ({offset:#x}): {preview}")
                if args.verbose and len(text) > 80:
                    print(f"      ...{text[80:160]}")
        else:
            print(f"  {pattern_name}: NO MATCHES")
    print()

    # Analyze and propose patches
    print("=== Patch Analysis ===")
    proposals = propose_patch(data, results)

    for i, prop in enumerate(proposals, 1):
        ptype = prop['type']
        print(f"\n--- Proposal {i}: {ptype} ---")
        print(f"  {prop['detail']}")

        if 'injection' in prop:
            print(f"  Injection ({prop['injection_bytes']} bytes): {prop['injection']}")
        if 'offset' in prop:
            print(f"  Target offset: {prop['offset']} ({prop['offset']:#x})")
        if 'context' in prop:
            print(f"  Context: ...{prop['context'][:120]}...")
        if 'context_preview' in prop:
            print(f"  Context: ...{prop['context_preview'][:120]}...")
        if 'feasibility' in prop:
            print(f"  Feasibility: {prop['feasibility']}")

    print()
    print("=== Summary ===")
    found = sum(1 for matches in results.values() if matches)
    total = len(results)
    print(f"  Patterns found: {found}/{total}")
    print(f"  Proposals: {len(proposals)}")

    if any(p['type'] == 'ERROR' for p in proposals):
        print("  Status: BLOCKED — missing critical patterns")
        sys.exit(1)
    else:
        print("  Status: READY FOR MANUAL VALIDATION")
        print()
        print("Next steps:")
        print("  1. Verify the injection offset is correct by examining surrounding bytes")
        print("  2. Identify expendable bytes near the injection point")
        print("  3. Test with a copy of the binary (cp claude claude.patched)")
        print("  4. Run: codesign --remove-signature claude.patched (if on macOS)")
        print("  5. Test: ./claude.patched --version")


if __name__ == '__main__':
    main()
