import fs from 'fs';
import path from 'path';
import { Session } from 'inspector';
import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from '@librechat/data-schemas';
import type { IntervalHistogram } from 'perf_hooks';

export interface ProfilerOptions {
  thresholdMs?: number;
  pollIntervalMs?: number;
  profileDurationMs?: number;
  cooldownMs?: number;
  outputDir?: string;
  maxProfiles?: number;
}

const DEFAULTS: Required<ProfilerOptions> = {
  thresholdMs: 1000,
  pollIntervalMs: 1000,
  profileDurationMs: 15_000,
  cooldownMs: 5 * 60_000,
  outputDir: '/home/LogFiles',
  maxProfiles: 5,
};

let histogram: IntervalHistogram | null = null;
let pollInterval: NodeJS.Timeout | null = null;
let session: Session | null = null;
let profileInProgress = false;
let lastProfileAt = 0;
let resolvedOutputDir: string = DEFAULTS.outputDir;
let maxProfiles: number = DEFAULTS.maxProfiles;

function resolveOutputDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    const fallback = process.cwd();
    logger.warn(
      `[CPUProfiler] Configured output directory "${dir}" is not writable, falling back to "${fallback}"`,
    );
    return fallback;
  }
}

function rotateProfiles(): void {
  try {
    const entries = fs
      .readdirSync(resolvedOutputDir)
      .filter((name) => name.startsWith('cpu-') && name.endsWith('.cpuprofile'))
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(resolvedOutputDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (let i = maxProfiles; i < entries.length; i++) {
      fs.unlinkSync(path.join(resolvedOutputDir, entries[i].name));
    }
  } catch (error) {
    logger.debug('[CPUProfiler] Profile rotation skipped:', error);
  }
}

function postSession(method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!session) {
      reject(new Error('Inspector session not connected'));
      return;
    }
    session.post(method, (err: Error | null, result: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

async function captureProfile(triggerReason: string, durationMs: number): Promise<void> {
  if (profileInProgress) return;
  profileInProgress = true;

  try {
    session = new Session();
    session.connect();

    await postSession('Profiler.enable');
    await postSession('Profiler.start');

    logger.warn(
      `[CPUProfiler] Triggered CPU profile: ${triggerReason}. Recording for ${durationMs}ms`,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));

    const result = (await postSession('Profiler.stop')) as { profile?: unknown } | undefined;
    const profile = result?.profile;

    session.disconnect();
    session = null;

    if (!profile) {
      logger.error('[CPUProfiler] Profiler.stop returned no profile data');
      return;
    }

    const filename = `cpu-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
    const fullPath = path.join(resolvedOutputDir, filename);
    fs.writeFileSync(fullPath, JSON.stringify(profile));

    logger.warn(`[CPUProfiler] CPU profile saved to ${fullPath}`);
    rotateProfiles();
  } catch (error) {
    logger.error('[CPUProfiler] Failed to capture CPU profile:', error);
    try {
      session?.disconnect();
    } catch {
      /* ignore */
    }
    session = null;
  } finally {
    profileInProgress = false;
    lastProfileAt = Date.now();
  }
}

function checkHistogram(options: Required<ProfilerOptions>): void {
  if (!histogram) return;

  const maxMs = histogram.max / 1e6;
  histogram.reset();

  if (maxMs < options.thresholdMs) return;

  if (profileInProgress) {
    logger.debug(
      `[CPUProfiler] Max delay ${maxMs.toFixed(0)}ms but a profile is already in progress`,
    );
    return;
  }

  const sinceLast = Date.now() - lastProfileAt;
  if (sinceLast < options.cooldownMs) {
    logger.debug(
      `[CPUProfiler] Max delay ${maxMs.toFixed(0)}ms but cooldown active (${(sinceLast / 1000).toFixed(0)}s / ${(options.cooldownMs / 1000).toFixed(0)}s)`,
    );
    return;
  }

  void captureProfile(
    `event loop max delay ${maxMs.toFixed(0)}ms exceeded threshold ${options.thresholdMs}ms`,
    options.profileDurationMs,
  );
}

function start(options: ProfilerOptions = {}): void {
  if (histogram) return;

  const merged: Required<ProfilerOptions> = {
    thresholdMs: options.thresholdMs ?? DEFAULTS.thresholdMs,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    profileDurationMs: options.profileDurationMs ?? DEFAULTS.profileDurationMs,
    cooldownMs: options.cooldownMs ?? DEFAULTS.cooldownMs,
    outputDir: options.outputDir ?? DEFAULTS.outputDir,
    maxProfiles: options.maxProfiles ?? DEFAULTS.maxProfiles,
  };
  resolvedOutputDir = resolveOutputDir(merged.outputDir);
  maxProfiles = merged.maxProfiles;

  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  pollInterval = setInterval(() => checkHistogram(merged), merged.pollIntervalMs);
  if (pollInterval.unref) pollInterval.unref();

  logger.info(
    `[CPUProfiler] Started (threshold: ${merged.thresholdMs}ms, profile duration: ${merged.profileDurationMs}ms, cooldown: ${merged.cooldownMs}ms, output: ${resolvedOutputDir})`,
  );
}

function stop(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
  try {
    session?.disconnect();
  } catch {
    /* ignore */
  }
  session = null;
  logger.info('[CPUProfiler] Stopped');
}

export const cpuProfiler = { start, stop };
