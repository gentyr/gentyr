/**
 * Ironscales icon processing script
 * Uses sharp + potrace + svgo to trace the favicon PNG to SVG
 */
const path = require('path');
const fs = require('fs');

const BASE = '/Users/jonathantodd/git/gentyr/.claude/worktrees/practical-williams/tmp/icons/ironscales-retry';

async function main() {
  // Dynamically load ESM modules
  const sharp = (await import('sharp')).default;
  const potrace = await import('potrace');
  const { optimize } = await import('svgo');
  const { svgPathBbox } = await import('svg-path-bbox');

  const inputFile = path.join(BASE, 'candidates', 'favicon.png');

  // Step 1: Analyze the image
  console.log('=== Step 1: Analyze image ===');
  const meta = await sharp(inputFile).metadata();
  console.log(`  Size: ${meta.width}x${meta.height}, Format: ${meta.format}, Channels: ${meta.channels}, HasAlpha: ${meta.hasAlpha}`);

  // Step 2: Check background - the favicon has a transparent background
  // and a blue hexagon with white icon inside
  console.log('=== Step 2: Background analysis ===');
  const { data, info } = await sharp(inputFile)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let transparentPixels = 0;
  let totalPixels = info.width * info.height;
  for (let i = 0; i < totalPixels; i++) {
    const offset = i * info.channels;
    if (info.channels === 4 && data[offset + 3] < 128) {
      transparentPixels++;
    }
  }
  console.log(`  Transparent pixels: ${transparentPixels}/${totalPixels} (${(transparentPixels/totalPixels*100).toFixed(1)}%)`);
  console.log(`  Background type: ${transparentPixels > totalPixels * 0.1 ? 'transparent' : 'solid'}`);

  // Step 3: Trace to SVG using potrace
  // Since the favicon is a blue shape on transparent background,
  // we need to threshold it properly
  console.log('=== Step 3: Trace to SVG ===');

  // Convert to grayscale with white background (potrace needs this)
  const grayscaleBuf = await sharp(inputFile)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .toBuffer();

  // Trace with potrace
  const tracedSvg = await new Promise((resolve, reject) => {
    potrace.trace(grayscaleBuf, {
      threshold: 128,
      color: '#2B59C3',
      optTolerance: 0.2,
      turdSize: 2,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  const tracedPath = path.join(BASE, 'processed', 'traced-favicon.svg');
  fs.writeFileSync(tracedPath, tracedSvg);
  console.log(`  Traced SVG saved to: ${tracedPath}`);

  // Also try posterize for multi-level tracing (captures the white inner detail)
  const posterizedSvg = await new Promise((resolve, reject) => {
    potrace.posterize(grayscaleBuf, {
      steps: 3,
      color: '#2B59C3',
      optTolerance: 0.2,
      turdSize: 2,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  const posterizedPath = path.join(BASE, 'processed', 'posterized-favicon.svg');
  fs.writeFileSync(posterizedPath, posterizedSvg);
  console.log(`  Posterized SVG saved to: ${posterizedPath}`);

  // Step 4: Also trace with inverted colors for the white-on-blue variant
  // The icon has a blue hexagon with white @ symbol inside
  // We need both the outer shape and inner cutout

  // Create an alpha-based trace (trace the opaque region)
  const alphaBuf = await sharp(inputFile)
    .extractChannel(3) // alpha channel
    .negate() // invert so opaque becomes dark
    .toBuffer();

  const alphaTracedSvg = await new Promise((resolve, reject) => {
    potrace.trace(alphaBuf, {
      threshold: 128,
      color: '#2B59C3',
      optTolerance: 0.2,
      turdSize: 2,
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });

  const alphaPath = path.join(BASE, 'processed', 'alpha-traced.svg');
  fs.writeFileSync(alphaPath, alphaTracedSvg);
  console.log(`  Alpha-traced SVG saved to: ${alphaPath}`);

  // Step 5: Normalize and optimize each SVG
  console.log('=== Step 5: Normalize + Optimize ===');

  for (const [name, svgContent] of [
    ['traced', tracedSvg],
    ['posterized', posterizedSvg],
    ['alpha-traced', alphaTracedSvg],
  ]) {
    // Extract paths and compute bounding box
    const pathRegex = /<path[^>]*\bd\s*=\s*"([^"]+)"/gi;
    const paths = [];
    let m;
    while ((m = pathRegex.exec(svgContent)) !== null) {
      paths.push(m[1]);
    }

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
        // skip invalid paths
      }
    }

    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const targetSize = 64;
    const padding = targetSize * 0.05; // 5% padding
    const usable = targetSize - padding * 2;
    const scale = usable / Math.max(contentW, contentH);

    const offsetX = padding + (usable - contentW * scale) / 2 - minX * scale;
    const offsetY = padding + (usable - contentH * scale) / 2 - minY * scale;

    // Build normalized SVG
    const normalizedPaths = paths.map(d => {
      return `<path d="${d}" transform="translate(${offsetX.toFixed(2)},${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})"/>`;
    }).join('\n  ');

    const normalizedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${targetSize} ${targetSize}" width="${targetSize}" height="${targetSize}" fill="#2B59C3">
  ${normalizedPaths}
</svg>`;

    // Optimize with SVGO
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
        'removeUnknownsAndDefaults',
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
    console.log(`  ${name}: ${paths.length} paths, bbox: [${minX.toFixed(1)},${minY.toFixed(1)} -> ${maxX.toFixed(1)},${maxY.toFixed(1)}]`);
    console.log(`    Saved: ${finalPath} (${optimized.data.length} bytes)`);
  }

  console.log('\n=== Done! ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
