/**
 * DemosTestsView — Page 2 of the live CTO dashboard.
 *
 * Layout (two-column + optional bottom output):
 *   Left  : ScenarioList (demo scenarios from user-feedback.db)
 *   Right : TestFileList (test files from playwright.config.ts)
 *   Bottom: OutputPanel (live output of running demo/test)
 *
 * Keyboard map:
 *   left/right   switch active panel
 *   up/down      navigate active list
 *   Enter        run selected item (demo=headed, test=headless)
 *   s            stop running process
 *   Escape       clear finished output
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { execFile } from 'child_process';
import { Box, Text, useInput } from 'ink';
import { Section } from './Section.js';
import { ScenarioList } from './page2/ScenarioList.js';
import { TestFileList, selectableCount } from './page2/TestFileList.js';
import { OutputPanel } from './page2/OutputPanel.js';
import { useProcessOutput } from '../hooks/useProcessOutput.js';
import { launchDemo, launchRemoteDemo, launchTest, checkProcess, killProcess, killRemoteProcess, releaseDemo } from '../utils/process-runner.js';
import type { Page2Data, RunningProcess, DemoEnvironment, DemoExecutionMode } from '../types.js';

interface DemosTestsViewProps {
  data: Page2Data;
  bodyHeight: number;
  bodyWidth: number;
  isActive: boolean;
}

type ActivePanel = 'demos' | 'tests';

const LEFT_WIDTH_FRACTION = 0.4;
const OUTPUT_HEIGHT_FRACTION = 0.35;
const HEADER_OVERHEAD = 2;
const DIVIDER_HEIGHT = 1;

export function DemosTestsView({ data, bodyHeight, bodyWidth, isActive }: DemosTestsViewProps): React.ReactElement {
  const [activePanel, setActivePanel] = useState<ActivePanel>('demos');
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(
    data.scenarios.length > 0 ? data.scenarios[0].id : null,
  );
  const [selectedTestIndex, setSelectedTestIndex] = useState(0);
  const [runningProcess, setRunningProcess] = useState<RunningProcess | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('local');
  const [executionMode, setExecutionMode] = useState<DemoExecutionMode>('local');

  // Resolve the active environment object
  const environments = data.environments.length > 0 ? data.environments : [{ id: 'local', label: 'Local', baseUrl: null } as DemoEnvironment];
  const selectedEnv = environments.find(e => e.id === selectedEnvId) || environments[0];

  // Auto-select first scenario when data loads and nothing is selected
  useEffect(() => {
    if (data.scenarios.length > 0 && (selectedScenarioId === null || !data.scenarios.some(s => s.id === selectedScenarioId))) {
      setSelectedScenarioId(data.scenarios[0].id);
    }
  }, [data.scenarios]);

  // Reset environment selection when the selected env is removed from config
  useEffect(() => {
    if (environments.length > 0 && !environments.some(e => e.id === selectedEnvId)) {
      setSelectedEnvId(environments[0].id);
    }
  }, [environments]);

  // Clear status timer on unmount
  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  // Tail the output file
  const outputFile = runningProcess?.outputFile ?? null;
  const { lines: outputLines } = useProcessOutput(outputFile);

  // Poll for process completion (1s interval)
  useEffect(() => {
    if (!runningProcess || runningProcess.status !== 'running') return;
    const id = setInterval(() => {
      const checked = checkProcess(runningProcess);
      if (checked.status !== 'running') {
        setRunningProcess(checked);
        clearInterval(id);
        // Release display/chrome-bridge locks when demo finishes
        if (runningProcess.type === 'demo') {
          releaseDemo().catch(() => { /* non-fatal */ });
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [runningProcess]);

  const handleRun = useCallback(async () => {
    if (runningProcess?.status === 'running') {
      setStatusMessage('Process already running — press s to stop');
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setStatusMessage(null), 3000);
      return;
    }

    try {
      if (activePanel === 'demos') {
        const scenario = data.scenarios.find(s => s.id === selectedScenarioId);
        if (!scenario) return;
        const proc = executionMode === 'remote'
          ? await launchRemoteDemo(scenario)
          : await launchDemo(scenario, selectedEnv.baseUrl);
        setRunningProcess(proc);
        setStatusMessage(null);
      } else {
        if (selectedTestIndex < 0 || selectedTestIndex >= data.testFiles.length) return;
        const testFile = data.testFiles[selectedTestIndex];
        const proc = launchTest(testFile);
        setRunningProcess(proc);
        setStatusMessage(null);
      }
    } catch (err) {
      setStatusMessage(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setStatusMessage(null), 5000);
    }
  }, [activePanel, selectedScenarioId, selectedTestIndex, data, runningProcess, selectedEnv, executionMode]);

  const handleStop = useCallback(() => {
    if (runningProcess?.status === 'running') {
      if (runningProcess.executionMode === 'remote') {
        killRemoteProcess(runningProcess).catch(() => { /* non-fatal */ });
      } else {
        killProcess(runningProcess);
      }
      setRunningProcess({ ...runningProcess, status: 'failed', exitCode: -1 });
      // Release display/chrome-bridge locks when demo is manually stopped
      if (runningProcess.type === 'demo') {
        releaseDemo().catch(() => { /* non-fatal */ });
      }
    }
  }, [runningProcess]);

  const handleClear = useCallback(() => {
    if (runningProcess && runningProcess.status !== 'running') {
      setRunningProcess(null);
    }
  }, [runningProcess]);

  const handleWatch = useCallback(() => {
    if (activePanel !== 'demos') return;
    const scenario = data.scenarios.find(s => s.id === selectedScenarioId);
    if (!scenario?.recordingPath) {
      setStatusMessage('No recording available for this scenario');
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setStatusMessage(null), 3000);
      return;
    }
    execFile('open', [scenario.recordingPath], (err) => {
      if (err) {
        setStatusMessage(`Failed to open video: ${err.message}`);
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => setStatusMessage(null), 5000);
      }
    });
  }, [activePanel, selectedScenarioId, data]);

  // Keyboard
  useInput((input, key) => {
    if (key.leftArrow) { setActivePanel('demos'); return; }
    if (key.rightArrow) { setActivePanel('tests'); return; }

    if (key.upArrow) {
      if (activePanel === 'demos') {
        const idx = data.scenarios.findIndex(s => s.id === selectedScenarioId);
        if (idx > 0) setSelectedScenarioId(data.scenarios[idx - 1].id);
      } else {
        setSelectedTestIndex(prev => Math.max(0, prev - 1));
      }
      return;
    }
    if (key.downArrow) {
      if (activePanel === 'demos') {
        const idx = data.scenarios.findIndex(s => s.id === selectedScenarioId);
        if (idx >= 0 && idx < data.scenarios.length - 1) setSelectedScenarioId(data.scenarios[idx + 1].id);
      } else {
        const max = selectableCount(data.testFiles) - 1;
        setSelectedTestIndex(prev => Math.min(max, prev + 1));
      }
      return;
    }

    if (key.return) { handleRun(); return; }
    if (input === 'e') {
      const idx = environments.findIndex(e => e.id === selectedEnvId);
      const next = environments[(idx + 1) % environments.length];
      setSelectedEnvId(next.id);
      setStatusMessage(`Environment: ${next.label}${next.baseUrl ? ` (${next.baseUrl})` : ''}`);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setStatusMessage(null), 3000);
      return;
    }
    if (input === 'r') {
      if (!data.flyStatus.configured) {
        setStatusMessage(`Remote unavailable: ${data.flyStatus.reason || 'Fly.io not configured — run /setup-fly'}`);
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => setStatusMessage(null), 5000);
        return;
      }
      const next: DemoExecutionMode = executionMode === 'local' ? 'remote' : 'local';
      setExecutionMode(next);
      setStatusMessage(`Execution: ${next === 'remote' ? `REMOTE (${data.flyStatus.appName}.fly.dev)` : 'LOCAL'}`);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setStatusMessage(null), 3000);
      return;
    }
    if (input === 'v' || input === 'w') { handleWatch(); return; }
    if (input === 's' || input === 'x') { handleStop(); return; }
    if (key.escape) { handleClear(); return; }
  }, { isActive });

  // Layout
  const leftWidth = Math.floor(bodyWidth * LEFT_WIDTH_FRACTION);
  const rightWidth = bodyWidth - leftWidth - 1;

  const showEnvBar = environments.length > 1;
  const showModeBar = data.flyStatus.configured;
  const controlBarHeight = (showEnvBar || showModeBar) ? 1 : 0;
  const hasOutput = runningProcess != null;
  const outputHeight = hasOutput ? Math.max(4, Math.floor(bodyHeight * OUTPUT_HEIGHT_FRACTION)) : 0;
  const listsHeight = bodyHeight - outputHeight - controlBarHeight;

  const leftInnerHeight = Math.max(2, listsHeight - HEADER_OVERHEAD);
  const rightInnerHeight = Math.max(2, listsHeight - HEADER_OVERHEAD);

  return (
    <Box flexDirection="column" height={bodyHeight}>
      {/* Control bar — environment selector + execution mode */}
      {(showEnvBar || showModeBar) && (
        <Box height={1} flexDirection="row">
          {showEnvBar && (
            <>
              <Text dimColor> ENV </Text>
              {environments.map((env) => (
                <Box key={env.id} marginRight={1}>
                  {env.id === selectedEnv.id
                    ? <Text bold inverse color="white">{` ${env.label} `}</Text>
                    : <Text dimColor>{` ${env.label} `}</Text>}
                </Box>
              ))}
              <Text dimColor>(e)</Text>
              {selectedEnv.baseUrl && <Text color="cyan"> {'\u2192'} {selectedEnv.baseUrl}</Text>}
            </>
          )}
          {showModeBar && (
            <>
              <Text dimColor>{showEnvBar ? '  \u2502 ' : ' '}</Text>
              <Text dimColor>RUN </Text>
              <Box marginRight={1}>
                {executionMode === 'local'
                  ? <Text bold inverse color="white">{' LOCAL '}</Text>
                  : <Text dimColor>{' LOCAL '}</Text>}
              </Box>
              <Box marginRight={1}>
                {executionMode === 'remote'
                  ? <Text bold inverse color="cyan">{' REMOTE '}</Text>
                  : <Text dimColor>{' REMOTE '}</Text>}
              </Box>
              <Text dimColor>(r)</Text>
            </>
          )}
        </Box>
      )}

      {/* Top: two-column lists */}
      <Box flexDirection="row" height={listsHeight}>
        <Section title="Demo Scenarios" width={leftWidth} tip={activePanel === 'demos' ? '\u25C0 active' : undefined}>
          <ScenarioList
            scenarios={data.scenarios}
            selectedId={selectedScenarioId}
            height={leftInnerHeight}
            width={leftWidth - 4}
            isActive={activePanel === 'demos'}
          />
        </Section>

        <Box width={1} />

        <Section title="Tests" width={rightWidth} flexGrow={1} tip={activePanel === 'tests' ? 'active \u25B6' : undefined}>
          <TestFileList
            testFiles={data.testFiles}
            selectedIndex={selectedTestIndex}
            height={rightInnerHeight}
            width={rightWidth - 4}
            isActive={activePanel === 'tests'}
          />
        </Section>
      </Box>

      {/* Bottom: output panel (if a process is active) */}
      {hasOutput && (
        <Box flexDirection="column" height={outputHeight}>
          <Box height={DIVIDER_HEIGHT}>
            <Text dimColor>{'\u2500'.repeat(Math.max(1, bodyWidth - 2))} </Text>
          </Box>
          <OutputPanel
            proc={runningProcess}
            lines={outputLines}
            height={outputHeight - DIVIDER_HEIGHT}
            width={bodyWidth - 2}
          />
        </Box>
      )}

      {/* Status message */}
      {statusMessage && (
        <Box>
          <Text color="yellow">{statusMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
