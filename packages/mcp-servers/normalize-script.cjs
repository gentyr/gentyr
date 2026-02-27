const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const BASE = '/Users/jonathantodd/git/gentyr/.claude/worktrees/practical-williams/tmp/icons/hillstone-networks';

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/icon-processor/server.js'] });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);

  const variants = ['variant-1-H-only', 'variant-2-Hi', 'variant-3-H-with-dot'];

  for (const v of variants) {
    const svgContent = fs.readFileSync(BASE + '/cleaned/' + v + '.svg', 'utf-8');

    const outputPath = BASE + '/final/' + v + '.svg';

    // Normalize
    const r1 = await client.callTool({ name: 'normalize_svg', arguments: {
      svg_content: svgContent,
      output_path: outputPath,
      target_size: 64,
      padding_percent: 5
    }});
    const normalized = JSON.parse(r1.content[0].text);
    if (!normalized.success) {
      console.log(v + ' normalize failed:', normalized.error);
      continue;
    }

    // Optimize
    const r2 = await client.callTool({ name: 'optimize_svg', arguments: {
      svg_content: normalized.svg_content
    }});
    const optimized = JSON.parse(r2.content[0].text);
    if (!optimized.success) {
      console.log(v + ' optimize failed:', optimized.error);
      continue;
    }

    fs.writeFileSync(BASE + '/final/' + v + '.svg', optimized.svg_content);
    console.log(v + ': saved (' + optimized.size_bytes + ' bytes, reduction: ' + optimized.size_reduction_percent + '%)');
  }

  await client.close();
}
main().catch(e => console.error(e));
