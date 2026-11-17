/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic frame-by-frame (stepped) MP4 capture using `chrome-headless-shell` +
 * `HeadlessExperimental.beginFrame` + `Page.startScreenRecording`.
 *
 * Unlike real-time `rAF` capture, each frame's presentation timestamp is stamped by
 * `beginFrame({frameTimeTicks})`, so even heavy/slow renders (or 120fps on a headless
 * CI machine with no 120Hz display) produce zero dropped frames and zero ffmpeg overhead.
 *
 * Requirements:
 *   - `chrome-headless-shell` M153+ (full Chrome rejects `HeadlessExperimental.beginFrame`).
 *   - Install latest via: `npx @puppeteer/browsers install chrome-headless-shell@canary`
 *
 * Usage:
 *   node examples/stepped-render/index.ts [output.mp4] [--fps=60] [--duration=3s] [--width=1280] [--height=720] [--busy-ms=0]
 */

import {readFileSync} from 'node:fs';
import {access, readdir, readFile} from 'node:fs/promises';
import {homedir, platform, uptime} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  connectCdpSession,
  launchChrome,
  parseDuration,
  startRecording,
} from '../../src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns system monotonic uptime in milliseconds.
 * `HeadlessExperimental.beginFrame` validates `frameTimeTicks` against the OS monotonic
 * clock (not 0 or Unix epoch); passing backward timestamps crashes the compositor.
 */
function getMonotonicUptimeMs(): number {
  if (platform() === 'linux') {
    try {
      const [secs] = readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/);
      const parsed = Number.parseFloat(secs);
      if (Number.isFinite(parsed)) return parsed * 1000;
    } catch {}
  }
  return uptime() * 1000;
}

/**
 * Locates a `chrome-headless-shell` (M153+) binary from `--chrome`, env var,
 * or the Puppeteer / Playwright browser caches.
 */
async function findHeadlessShellBinary(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    await access(explicitPath);
    return explicitPath;
  }

  const envPath = process.env.CHROME_HEADLESS_SHELL_PATH;
  if (envPath) {
    await access(envPath);
    return envPath;
  }

  const isMac = platform() === 'darwin';
  const exe = isMac ? 'chrome-headless-shell-mac-arm64/chrome-headless-shell' : 'chrome-headless-shell-linux64/chrome-headless-shell';
  const pptrCache = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  try {
    const entries = (await readdir(pptrCache))
      .filter(e => e.startsWith(isMac ? 'mac' : 'linux-') && !e.endsWith('.zip'))
      .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    for (const entry of entries.reverse()) {
      const candidate = join(pptrCache, entry, exe);
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
  } catch {}

  throw new Error(
    'Could not find chrome-headless-shell (M153+). Install via:\n' +
    '  npx @puppeteer/browsers install chrome-headless-shell@canary\n' +
    'Or pass --chrome=/path/to/chrome-headless-shell',
  );
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    options: {
      fps: {type: 'string', default: '60'},
      duration: {type: 'string', default: '3s'},
      width: {type: 'string', default: '1280'},
      height: {type: 'string', default: '720'},
      'busy-ms': {type: 'string', default: '0'},
      chrome: {type: 'string'},
    },
    allowPositionals: true,
  });

  const outputPath = positionals[0] ?? 'stepped-render.mp4';
  const fps = Number.parseInt(values.fps, 10);
  const durationMs = parseDuration(values.duration, 3000);
  const width = Number.parseInt(values.width, 10);
  const height = Number.parseInt(values.height, 10);
  const busyMs = Number.parseInt(values['busy-ms'], 10);
  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const intervalMs = 1000 / fps;
  // Wall-clock pacing floor prevents `beginFrame` bursts from exhausting the 10-slot
  // shared-memory buffer pool while software libaom encodes.
  const minStepWallMs = width * height >= 2560 * 1440 ? 24 : 12;

  const shellPath = await findHeadlessShellBinary(values.chrome);
  const html = await readFile(join(__dirname, 'index.html'), 'utf8');

  console.log(`Using: ${shellPath}`);
  console.log(`Rendering ${totalFrames} frames (${width}x${height} @ ${fps}fps, busyMs=${busyMs}) -> ${outputPath}`);

  const launched = await launchChrome({
    explicitPath: shellPath,
    headless: false, // chrome-headless-shell is already headless; do not pass --headless=new
    width,
    height,
    extraArgs: [
      '--deterministic-mode',
      '--enable-begin-frame-control',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
    ],
  });

  const tStart = performance.now();
  try {
    const session = await connectCdpSession(launched.pageTargetWs);
    try {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await session.send('HeadlessExperimental.enable');

      const {frameTree} = await session.send('Page.getFrameTree');
      await session.send('Page.setDocumentContent', {frameId: frameTree.frame.id, html});

      // Anchor synthetic frame timestamps 2s ahead of system monotonic uptime.
      let frameTimeTicks = getMonotonicUptimeMs() + 2000;

      // Pre-render frame 0 before starting the recorder so the first captured surface is ready.
      await session.send('Runtime.evaluate', {
        expression: `window.renderAt(0, ${fps}, ${totalFrames}, 0)`,
      });
      await session.send('HeadlessExperimental.beginFrame', {frameTimeTicks, interval: intervalMs});

      // Pass frameRate: 1000 so FrameSinkVideoCapturer's wall-clock minimum capture period
      // drops to 1ms instead of dropping stepped ticks that finish faster than 1000 / fps.
      await using _rec = await startRecording(session, {
        frameRate: 1000,
        maxWidth: width,
        maxHeight: height,
        outputPath,
      });

      for (let frame = 0; frame < totalFrames; frame++) {
        const stepStart = performance.now();
        await session.send('Runtime.evaluate', {
          expression: `window.renderAt(${frame}, ${fps}, ${totalFrames}, ${busyMs})`,
        });
        frameTimeTicks += intervalMs;
        await session.send('HeadlessExperimental.beginFrame', {frameTimeTicks, interval: intervalMs});

        const remaining = minStepWallMs - (performance.now() - stepStart);
        if (remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, remaining));
        }
      }
    } finally {
      session.close();
    }
  } finally {
    await launched.close();
  }

  const elapsedSec = ((performance.now() - tStart) / 1000).toFixed(2);
  console.log(`Saved ${outputPath} (${totalFrames} frames in ${elapsedSec}s wall time)`);
}

await main();
