/**
 * ReleaseBanner — compact status banner shown on Page 1 when a production
 * release is in progress. Renders above the ObserveView main content.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ReleaseStatus } from '../types.js';

interface ReleaseBannerProps {
  release: ReleaseStatus;
  width: number;
}

export function ReleaseBanner({ release, width }: ReleaseBannerProps): React.ReactElement {
  const version = release.version || 'unreleased';
  const phaseLabel = release.totalPhases > 0
    ? `Phase: ${release.completedPhases}/${release.totalPhases}` + (release.currentPhase ? ` - ${release.currentPhase}` : '')
    : 'Initializing...';
  const prLabel = `PRs: ${release.passedPrs}/${release.prCount} reviewed`;
  const sessionLabel = `Sessions: ${release.sessionCount}`;

  const innerWidth = Math.max(20, width - 4);

  // Build the top line: release ID + version
  const topLine = `${release.releaseId}  ${version}`;
  // Build the bottom line: phase + PRs + sessions + lock status
  const bottomLine = `${phaseLabel}  ${prLabel}  ${sessionLabel}  Staging: LOCKED`;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
    >
      <Box>
        <Text color="yellow" bold>PRODUCTION RELEASE</Text>
        <Text color="white">{'  '}{topLine.substring(0, innerWidth - 22)}</Text>
      </Box>
      <Box>
        <Text color="white">{bottomLine.substring(0, innerWidth)}</Text>
      </Box>
    </Box>
  );
}
