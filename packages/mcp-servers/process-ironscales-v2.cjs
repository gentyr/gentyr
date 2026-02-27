/**
 * Ironscales icon processing script v2
 * Properly handles fill-rule: evenodd for the traced favicon
 */
const path = require('path');
const fs = require('fs');

const BASE = '/Users/jonathantodd/git/gentyr/.claude/worktrees/practical-williams/tmp/icons/ironscales-retry';

async function main() {
  const sharp = (await import('sharp')).default;
  const potrace = await import('potrace');
  const { optimize } = await import('svgo');
  const { svgPathBbox } = await import('svg-path-bbox');

  const inputFile = path.join(BASE, 'candidates', 'favicon.png');

  // Step 1: Create a high-quality grayscale version for tracing
  console.log('=== Step 1: Prepare image ===');

  // The favicon is a blue hexagon on transparent bg with white internal detail
  // For tracing: flatten to white bg, then the blue becomes dark, white stays white
  const grayscaleBuf = await sharp(inputFile)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .toBuffer();

  // Step 2: Trace with different quality settings
  console.log('=== Step 2: Trace variants ===');

  // High quality trace
  const hqSvg = await new Promise((resolve, reject) => {
    potrace.trace(grayscaleBuf, {
      threshold: 128,
      color: '#2B59C3',
      optTolerance: 0.2,
      turdSize: 2,
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  // Ultra-smooth trace (less detail but smoother curves)
  const smoothSvg = await new Promise((resolve, reject) => {
    potrace.trace(grayscaleBuf, {
      threshold: 128,
      color: '#2B59C3',
      optTolerance: 0.8,
      turdSize: 5,
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  // Save raw traces
  fs.writeFileSync(path.join(BASE, 'processed', 'hq-trace.svg'), hqSvg);
  fs.writeFileSync(path.join(BASE, 'processed', 'smooth-trace.svg'), smoothSvg);

  // Step 3: Normalize each variant
  console.log('=== Step 3: Normalize + Optimize ===');

  for (const [name, rawSvg] of [['hq', hqSvg], ['smooth', smoothSvg]]) {
    // Extract paths
    const pathRegex = /<path[^>]*\bd\s*=\s*"([^"]+)"/gi;
    const paths = [];
    let m;
    while ((m = pathRegex.exec(rawSvg)) !== null) {
      paths.push(m[1]);
    }

    // Check for fill-rule
    const hasFillRule = rawSvg.includes('fill-rule="evenodd"');

    // Compute overall bbox
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of paths) {
      try {
        const [x1, y1, x2, y2] = svgPathBbox(d);
        if (isFinite(x1)) minX = Math.min(minX, x1);
        if (isFinite(y1)) minY = Math.min(minY, y1);
        if (isFinite(x2)) maxX = Math.max(maxX, x2);
        if (isFinite(y2)) maxY = Math.max(maxY, y2);
      } catch (e) {
        // skip
      }
    }

    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const targetSize = 64;
    const padding = targetSize * 0.05;
    const usable = targetSize - padding * 2;
    const scale = usable / Math.max(contentW, contentH);

    const offsetX = padding + (usable - contentW * scale) / 2 - minX * scale;
    const offsetY = padding + (usable - contentH * scale) / 2 - minY * scale;

    // Build normalized SVG - KEEP fill-rule="evenodd" for cutout effect
    const fillRuleAttr = hasFillRule ? ' fill-rule="evenodd"' : '';
    const normalizedPaths = paths.map(d => {
      return `<path d="${d}" transform="translate(${offsetX.toFixed(2)},${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})"${fillRuleAttr}/>`;
    }).join('\n  ');

    const normalizedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${targetSize} ${targetSize}" width="${targetSize}" height="${targetSize}" fill="#2B59C3">
  ${normalizedPaths}
</svg>`;

    // Optimize with SVGO - be careful not to strip fill-rule
    const optimized = optimize(normalizedSvg, {
      plugins: [
        'removeDoctype',
        'removeXMLProcInst',
        'removeComments',
        'removeMetadata',
        'removeEditorsNSData',
        'cleanupAttrs',
        'mergeStyles',
        'minifyStyles',
        'cleanupIds',
        'removeUselessDefs',
        'cleanupNumericValues',
        'convertColors',
        {
          name: 'removeUnknownsAndDefaults',
          params: { keepRoleAttr: true },
        },
        'removeNonInheritableGroupAttrs',
        'removeUselessStrokeAndFill',
        'cleanupEnableBackground',
        'convertPathData',
        'convertTransform',
        'removeEmptyAttrs',
        'removeEmptyContainers',
        'removeUnusedNS',
        'sortAttrs',
      ],
    });

    const finalPath = path.join(BASE, 'final', `${name}-v2.svg`);
    fs.writeFileSync(finalPath, optimized.data);
    console.log(`  ${name}: ${paths.length} paths, fillRule=${hasFillRule}, ${optimized.data.length} bytes`);
    console.log(`    bbox: [${minX.toFixed(1)},${minY.toFixed(1)} -> ${maxX.toFixed(1)},${maxY.toFixed(1)}]`);
    console.log(`    Saved: ${finalPath}`);

    // Also save a black variant
    const blackSvg = optimized.data.replace(/#2B59C3/gi, '#000');
    const blackPath = path.join(BASE, 'final', `${name}-v2-black.svg`);
    fs.writeFileSync(blackPath, blackSvg);
    console.log(`    Black variant: ${blackPath}`);
  }

  console.log('\n=== Done! ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
