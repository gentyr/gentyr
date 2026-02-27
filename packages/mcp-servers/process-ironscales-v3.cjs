/**
 * Ironscales icon processing script v3
 * - Crops the seeklogo image to extract just the icon portion
 * - Traces from higher-res source
 * - Cleans up stray paths
 */
const path = require('path');
const fs = require('fs');

const BASE = '/Users/jonathantodd/git/gentyr/.claude/worktrees/practical-williams/tmp/icons/ironscales-retry';

async function main() {
  const sharp = (await import('sharp')).default;
  const potrace = await import('potrace');
  const { optimize } = await import('svgo');
  const { svgPathBbox } = await import('svg-path-bbox');

  // ===================================================================
  // Approach 1: Trace from the 250x250 favicon (icon-only, clean source)
  // ===================================================================
  console.log('=== Approach 1: Favicon trace (250x250) ===');
  const faviconFile = path.join(BASE, 'candidates', 'favicon.png');

  // Upscale to 500x500 for better tracing quality
  const upscaledBuf = await sharp(faviconFile)
    .resize(500, 500, { kernel: 'lanczos3' })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .toBuffer();

  const faviconSvg = await new Promise((resolve, reject) => {
    potrace.trace(upscaledBuf, {
      threshold: 128,
      color: '#2B59C3',
      optTolerance: 0.2,
      turdSize: 5, // Filter out small specks
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  // ===================================================================
  // Approach 2: Crop and trace the seeklogo 600x600
  // The seeklogo has the icon on the left portion. The icon is roughly
  // the left 35-40% of the image horizontally, centered vertically.
  // ===================================================================
  console.log('=== Approach 2: Seeklogo cropped trace (600x600) ===');
  const seeklogoFile = path.join(BASE, 'candidates', 'seeklogo.png');

  // First analyze the seeklogo to find the icon bounds
  const seekMeta = await sharp(seeklogoFile).metadata();
  console.log(`  Seeklogo: ${seekMeta.width}x${seekMeta.height}`);

  // The icon is in the left portion. Crop left ~230px of the 600px wide image
  // and center vertically. The seeklogo has the icon centered at about x=115, y=300
  const croppedBuf = await sharp(seeklogoFile)
    .extract({ left: 10, top: 75, width: 230, height: 450 })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .toBuffer();

  fs.writeFileSync(path.join(BASE, 'processed', 'seeklogo-cropped.png'),
    await sharp(seeklogoFile)
      .extract({ left: 10, top: 75, width: 230, height: 450 })
      .toBuffer()
  );

  const seekSvg = await new Promise((resolve, reject) => {
    potrace.trace(croppedBuf, {
      threshold: 128,
      color: '#2B59C3',
      optTolerance: 0.2,
      turdSize: 5,
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  // ===================================================================
  // Process both approaches
  // ===================================================================
  for (const [name, rawSvg] of [['favicon-upscaled', faviconSvg], ['seeklogo-cropped', seekSvg]]) {
    console.log(`\n=== Processing: ${name} ===`);

    // Extract paths with fill-rule
    const pathRegex = /<path[^>]*\bd\s*=\s*"([^"]+)"/gi;
    const allPaths = [];
    let m;
    while ((m = pathRegex.exec(rawSvg)) !== null) {
      allPaths.push(m[1]);
    }

    const hasFillRule = rawSvg.includes('fill-rule="evenodd"');

    // Compute bbox for each path individually to filter tiny ones
    const pathsWithBbox = [];
    for (const d of allPaths) {
      try {
        const [x1, y1, x2, y2] = svgPathBbox(d);
        const w = x2 - x1;
        const h = y2 - y1;
        const area = w * h;
        pathsWithBbox.push({ d, bbox: { x1, y1, x2, y2, w, h }, area });
      } catch (e) {
        // skip
      }
    }

    // Sort by area descending
    pathsWithBbox.sort((a, b) => b.area - a.area);

    console.log(`  Found ${pathsWithBbox.length} paths:`);
    pathsWithBbox.forEach((p, i) => {
      console.log(`    Path ${i}: area=${p.area.toFixed(0)}, size=${p.bbox.w.toFixed(1)}x${p.bbox.h.toFixed(1)}`);
    });

    // Keep only paths that are at least 1% of the largest path's area
    const largestArea = pathsWithBbox[0]?.area || 0;
    const significantPaths = pathsWithBbox.filter(p => p.area >= largestArea * 0.01);
    console.log(`  Keeping ${significantPaths.length} significant paths (filtered ${pathsWithBbox.length - significantPaths.length} specks)`);

    // Compute overall bbox from significant paths
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of significantPaths) {
      minX = Math.min(minX, p.bbox.x1);
      minY = Math.min(minY, p.bbox.y1);
      maxX = Math.max(maxX, p.bbox.x2);
      maxY = Math.max(maxY, p.bbox.y2);
    }

    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const targetSize = 64;
    const padding = targetSize * 0.05;
    const usable = targetSize - padding * 2;
    const scale = usable / Math.max(contentW, contentH);

    const offsetX = padding + (usable - contentW * scale) / 2 - minX * scale;
    const offsetY = padding + (usable - contentH * scale) / 2 - minY * scale;

    const fillRuleAttr = hasFillRule ? ' fill-rule="evenodd"' : '';
    const normalizedPaths = significantPaths.map(p => {
      return `<path d="${p.d}" transform="translate(${offsetX.toFixed(2)},${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})"${fillRuleAttr}/>`;
    }).join('\n  ');

    const normalizedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${targetSize} ${targetSize}" width="${targetSize}" height="${targetSize}" fill="#2B59C3">
  ${normalizedPaths}
</svg>`;

    // Optimize
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

    const finalPath = path.join(BASE, 'final', `${name}.svg`);
    fs.writeFileSync(finalPath, optimized.data);
    console.log(`  Output: ${finalPath} (${optimized.data.length} bytes)`);
  }

  console.log('\n=== All done! ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
