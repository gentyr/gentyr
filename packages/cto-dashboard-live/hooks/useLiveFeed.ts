/**
 * useLiveFeed — Core hook for the AI commentary feed (Page 5).
 *
 * Every 60 seconds, checks for new session/plan activity. If detected,
 * spawns `claude -p` with streaming output to generate commentary.
 * Previous messages are included in the prompt for context continuity.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { Page5Data, FeedMessage, CommentaryContext } from '../types.js';
import { getMockPage5Data } from '../mock-data.js';
import { readCommentaryContext, getActivityFingerprint } from '../live-reader.js';

const POLL_INTERVAL_MS = 60_000;
const MAX_PREVIOUS_MESSAGES = 10;
const MAX_PREVIOUS_CHARS = 8000;
const MAX_FEED_MESSAGES = 200;

const SYSTEM_PROMPT = `You are the CTO's live AI narrator for a multi-agent software development system called GENTYR. Write 2-4 sentences of concise commentary about what is currently happening across all running agent sessions. Be specific: name agents, tools, features, PRs, plan phases. Note progress milestones, blockers, interesting patterns, or risks. Write in present tense. Do not repeat information already covered in previous commentary messages — build on them instead.`;

function buildPrompt(ctx: CommentaryContext, previousMessages: FeedMessage[], streamingPartial: string): string {
  const sections: string[] = [];

  // Current sessions
  if (ctx.sessions.length > 0) {
    sections.push('== CURRENT SESSIONS ==');
    for (const s of ctx.sessions) {
      let line = `- [${s.agentType}] "${s.title}"`;
      if (s.lastTool) line += ` | last tool: ${s.lastTool}`;
      if (s.lastMessage) line += ` | last msg: ${s.lastMessage.slice(0, 150)}`;
      sections.push(line);
    }
  } else {
    sections.push('== CURRENT SESSIONS ==\n(no running sessions)');
  }

  // Recent summaries
  if (ctx.recentSummaries.length > 0) {
    sections.push('\n== RECENT SESSION SUMMARIES ==');
    for (const s of ctx.recentSummaries) {
      sections.push(`- [${s.title}]: ${s.summary.slice(0, 300)}`);
    }
  }

  // Project summary
  if (ctx.projectSummary) {
    sections.push(`\n== PROJECT SUMMARY ==\n${ctx.projectSummary.slice(0, 500)}`);
  }

  // Plan status
  if (ctx.plans.length > 0) {
    sections.push('\n== ACTIVE PLANS ==');
    for (const p of ctx.plans) {
      let line = `- "${p.title}" [${p.status}] ${p.progressPct}%`;
      if (p.currentPhase) line += ` | current phase: ${p.currentPhase}`;
      sections.push(line);
    }
  }

  // Previous commentary (for context, truncated)
  if (previousMessages.length > 0 || streamingPartial) {
    sections.push('\n== PREVIOUS COMMENTARY (do not repeat, build on these) ==');
    let charBudget = MAX_PREVIOUS_CHARS;
    const msgs = previousMessages.slice(-MAX_PREVIOUS_MESSAGES);
    for (const m of msgs) {
      const entry = `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.text}`;
      if (entry.length > charBudget) break;
      sections.push(entry);
      charBudget -= entry.length;
    }
    if (streamingPartial) {
      sections.push(`[generating, incomplete] ${streamingPartial.slice(0, 500)}`);
    }
  }

  sections.push('\nGenerate the next commentary message (2-4 sentences).');
  return sections.join('\n');
}

export function useLiveFeed(mock: boolean): Page5Data {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lastFingerprintRef = useRef('');
  const childRef = useRef<ChildProcess | null>(null);
  const streamBufferRef = useRef('');
  const accumulatedTextRef = useRef('');
  const messagesRef = useRef<FeedMessage[]>([]);

  // Keep messagesRef in sync with state (for use in callbacks)
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const killCurrentChild = useCallback(() => {
    if (childRef.current) {
      try { childRef.current.kill(); } catch { /* */ }
      childRef.current = null;
    }
  }, []);

  const startGeneration = useCallback(() => {
    // Kill any in-flight generation
    if (childRef.current) {
      // Finalize partial text as interrupted message
      const partial = accumulatedTextRef.current.trim();
      if (partial) {
        const msg: FeedMessage = {
          id: randomUUID(),
          text: partial + ' [interrupted]',
          timestamp: new Date().toISOString(),
          tokensUsed: 0,
        };
        setMessages(prev => [...prev, msg].slice(-MAX_FEED_MESSAGES));
      }
      killCurrentChild();
    }

    setIsGenerating(true);
    setError(null);
    accumulatedTextRef.current = '';
    streamBufferRef.current = '';
    setStreamingText('');

    // Gather context
    let ctx: CommentaryContext;
    try {
      ctx = readCommentaryContext();
    } catch {
      setError('Failed to read context');
      setIsGenerating(false);
      return;
    }

    const prompt = buildPrompt(ctx, messagesRef.current, '');

    const child = spawn('claude', [
      '-p', prompt,
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', 'haiku',
    ], {
      env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    childRef.current = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      streamBufferRef.current += chunk.toString('utf8');

      // Process complete lines
      const lines = streamBufferRef.current.split('\n');
      // Keep the last fragment (may be incomplete)
      streamBufferRef.current = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            type: string;
            subtype?: string;
            message?: { content?: Array<{ type: string; text?: string }> };
            result?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                // With --include-partial-messages, each assistant event contains the
                // FULL text accumulated so far (cumulative), not a delta — use assignment.
                accumulatedTextRef.current = block.text;
                setStreamingText(block.text);
              }
            }
          } else if (parsed.type === 'result') {
            const finalText = (parsed.result ?? accumulatedTextRef.current).trim();
            if (finalText && parsed.subtype === 'success') {
              const tokens = (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0);
              const msg: FeedMessage = {
                id: randomUUID(),
                text: finalText,
                timestamp: new Date().toISOString(),
                tokensUsed: tokens,
              };
              setMessages(prev => [...prev, msg].slice(-MAX_FEED_MESSAGES));
              setLastGeneratedAt(new Date().toISOString());
            } else if (parsed.subtype !== 'success') {
              setError(`LLM call failed: ${parsed.subtype ?? 'unknown'}`);
            }
            setStreamingText('');
            setIsGenerating(false);
            accumulatedTextRef.current = '';
            childRef.current = null;
          }
        } catch {
          // Ignore unparseable lines (init, rate_limit, etc.)
        }
      }
    });

    child.stderr?.on('data', () => { /* ignore stderr */ });

    child.on('error', (err: Error) => {
      setError(`spawn error: ${err.message}`);
      setIsGenerating(false);
      childRef.current = null;
    });

    child.on('close', (code: number | null) => {
      // If we didn't get a result line, finalize whatever we have
      if (childRef.current === child) {
        const partial = accumulatedTextRef.current.trim();
        if (partial) {
          const msg: FeedMessage = {
            id: randomUUID(),
            text: partial,
            timestamp: new Date().toISOString(),
            tokensUsed: 0,
          };
          setMessages(prev => [...prev, msg].slice(-MAX_FEED_MESSAGES));
          setLastGeneratedAt(new Date().toISOString());
        }
        setStreamingText('');
        setIsGenerating(false);
        accumulatedTextRef.current = '';
        childRef.current = null;
        if (code !== 0 && code !== null) {
          setError(`claude exited with code ${code}`);
        }
      }
    });
  }, [killCurrentChild]);

  // Polling interval — always runs (even when page is not active)
  useEffect(() => {
    if (mock) return;

    const check = () => {
      try {
        const fingerprint = getActivityFingerprint();
        if (fingerprint && fingerprint !== lastFingerprintRef.current) {
          lastFingerprintRef.current = fingerprint;
          startGeneration();
        }
      } catch { /* */ }
    };

    // Initial check after a short delay (let the dashboard render first)
    const initialTimeout = setTimeout(check, 3000);
    const interval = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
      killCurrentChild();
    };
  }, [mock, startGeneration, killCurrentChild]);

  if (mock) {
    return getMockPage5Data();
  }

  return { messages, streamingText, isGenerating, lastGeneratedAt, error };
}
