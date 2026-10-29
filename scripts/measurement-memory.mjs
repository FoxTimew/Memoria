import { guardTestDocker } from './docker-test-isolation.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { freemem, platform } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readMeasurementPower, assertMeasurementPower } from './measurement-power.mjs';

const GiB = 1024 ** 3;
const fail = (reason, observation) => Object.assign(new Error(reason), { reason, observation });
export const memoryProtocol = '2026-10-26-windows-wsl-no-swap-v1';

export function parseWslSnapshot(text) {
  const value = (pattern) => {
    const match = text.match(pattern);
    if (!match) throw fail('WSL_MEMORY_PROBE_FAILED');
    const result = Number(match[1]);
    if (!Number.isSafeInteger(result) || result < 0) throw fail('WSL_MEMORY_PROBE_FAILED');
    return result;
  };
  const bootId = text.match(/^BOOT ([a-f0-9-]{36})$/m)?.[1];
  if (!bootId) throw fail('WSL_MEMORY_PROBE_FAILED');
  return {
    bootId,
    memAvailableBytes: value(/^MemAvailable:\s+(\d+) kB$/m) * 1024,
    swapInPages: value(/^pswpin (\d+)$/m),
    swapOutPages: value(/^pswpout (\d+)$/m),
  };
}

export function readMemorySnapshot() {
  if (platform() !== 'win32') throw fail('WINDOWS_WSL_PROBE_REQUIRED');
  const wsl = parseWslSnapshot(
    execFileSync(
      'wsl.exe',
      [
        '-d',
        'docker-desktop',
        '--',
        'sh',
        '-c',
        "printf 'BOOT '; cat /proc/sys/kernel/random/boot_id; cat /proc/meminfo; cat /proc/vmstat",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ).replaceAll('\r', ''),
  );
  return {
    observedAt: new Date().toISOString(),
    windowsFreeBytes: freemem(),
    wsl,
    power: readMeasurementPower(),
  };
}

export function assertMemoryStage(observation, stage) {
  assertMeasurementPower(observation.power);
  const windowsMinimum = stage === 'before-preparation' ? 3 * GiB : 1.5 * GiB;
  if (
    !Number.isFinite(observation.windowsFreeBytes) ||
    observation.windowsFreeBytes < windowsMinimum
  )
    throw fail(
      stage === 'before-preparation'
        ? 'WINDOWS_BEFORE_PREPARATION_BELOW_3_GIB'
        : 'WINDOWS_AFTER_PREPARATION_BELOW_1_5_GIB',
      observation,
    );
  if (
    !Number.isFinite(observation.wsl?.memAvailableBytes) ||
    (stage !== 'before-preparation' && observation.wsl.memAvailableBytes < 2 * GiB)
  )
    throw fail('WSL_MEMAVAILABLE_BELOW_2_GIB_OR_UNAVAILABLE', observation);
  if (!['before-preparation', 'after-preparation'].includes(stage))
    throw fail('INVALID_MEMORY_STAGE');
}

const safeLabel = (label) => {
  if (!/^[a-z0-9.-]+$/.test(label)) throw fail('INVALID_MEASUREMENT_LABEL');
  return label;
};
const save = async (path, evidence) => {
  await mkdir('.local/measurement-hygiene', { recursive: true });
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
};

export async function prepareMeasurement(label) {
  safeLabel(label);
  const path = `.local/measurement-hygiene/${label}-preparation-${randomUUID()}.json`;
  const evidence = {
    protocol: memoryProtocol,
    label,
    phase: 'before-preparation',
    status: 'pending',
  };
  try {
    evidence.observation = readMemorySnapshot();
    assertMemoryStage(evidence.observation, 'before-preparation');
    evidence.status = 'allowed';
  } catch (error) {
    evidence.status = 'refused';
    evidence.reason = error.message;
    throw error;
  } finally {
    await save(path, evidence);
    console.log(JSON.stringify({ preparation: path, ...evidence }));
  }
  return { path, observation: evidence.observation };
}

export function parseVmstat(raw) {
  let header;
  const rows = [];
  let bootId, version;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('BOOT ')) bootId = line.slice(5).trim();
    if (line.startsWith('vmstat from ')) version = line.trim();
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'r' && fields.includes('si') && fields.includes('so')) header = fields;
    else if (/^\d+$/.test(fields[0] ?? '')) {
      if (!header || fields.length !== header.length || fields.some((v) => !/^\d+$/.test(v)))
        throw fail('INVALID_VMSTAT_ROW');
      rows.push({
        si: Number(fields[header.indexOf('si')]),
        so: Number(fields[header.indexOf('so')]),
      });
    }
  }
  return { bootId, version, rows };
}

export function assessSwap(trace, before, after) {
  const parsed = parseVmstat(trace.raw);
  if (
    !parsed.version ||
    parsed.rows.length < 2 ||
    trace.probeError ||
    trace.stderr ||
    parsed.bootId !== before.wsl.bootId ||
    parsed.bootId !== after.wsl.bootId ||
    !Number.isFinite(trace.startedAt) ||
    !Number.isFinite(trace.endedAt) ||
    !Number.isFinite(trace.workStartedAt) ||
    !Number.isFinite(trace.workEndedAt) ||
    trace.startedAt > trace.workStartedAt ||
    trace.endedAt < trace.workEndedAt
  )
    return { valid: false, reason: 'SWAP_PROBE_INCOMPLETE' };
  const deltaIn = after.wsl.swapInPages - before.wsl.swapInPages;
  const deltaOut = after.wsl.swapOutPages - before.wsl.swapOutPages;
  if (![deltaIn, deltaOut].every((n) => Number.isSafeInteger(n) && n >= 0))
    return { valid: false, reason: 'SWAP_COUNTER_RESET_OR_INVALID' };
  const swapped =
    parsed.rows.some((r) => r.si !== 0 || r.so !== 0) || deltaIn !== 0 || deltaOut !== 0;
  return {
    valid: !swapped,
    reason: swapped ? 'SWAP_ACTIVITY' : null,
    intervals: parsed.rows.length,
    deltaInPages: deltaIn,
    deltaOutPages: deltaOut,
  };
}

// Ubuntu is a read-only probe, not an app service; /proc must identify the same WSL kernel.
// No pull/build/network or privileged mode during measurement. Existing local image required.
export async function startSwapMonitor() {
  const name = 'memoria-vmstat-' + randomUUID();
  const image = 'ubuntu:24.04';
  const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  }).trim();
  const startedAt = Date.now();
  const child = spawn(
    'docker',
    guardTestDocker([
      'run',
      '--rm',
      '--pull=never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--name',
      name,
      imageId,
      'sh',
      '-c',
      "printf 'BOOT '; cat /proc/sys/kernel/random/boot_id; vmstat -V; exec vmstat -w -n -y 1",
    ]),
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let raw = '',
    stderr = '',
    probeError = null,
    closed = false;
  const chunks = [];
  child.stdout.on('data', (chunk) => {
    raw += chunk.toString();
    chunks.push({ observedAt: new Date().toISOString(), text: chunk.toString() });
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (e) => {
    probeError = e.message;
  });
  child.on('close', (code) => {
    closed = true;
    probeError ??= `Unexpected vmstat exit ${code}`;
  });
  const wait = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (closed || probeError || Date.now() >= deadline)
        throw fail('VMSTAT_PROBE_FAILED', { stderr, probeError });
      await delay(25);
    }
  };
  const completeRaw = () => raw.slice(0, raw.lastIndexOf('\n') + 1);
  const close = () => {
    // Only this randomly named, volume-free probe container is removed.
    try {
      execFileSync('docker', ['rm', '--force', name], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10000,
      });
    } finally {
      child.kill();
    }
  };
  try {
    await wait(() => parseVmstat(completeRaw()).rows.length >= 1);
  } catch (error) {
    close();
    throw error;
  }
  return {
    async finish() {
      const n = parseVmstat(completeRaw()).rows.length;
      await wait(() => parseVmstat(completeRaw()).rows.length > n);
      return {
        raw: completeRaw(),
        chunks,
        startedAt,
        endedAt: Date.now(),
        probeError,
        stderr,
        imageId,
        command: 'vmstat -w -n -y 1',
        intervalSeconds: 1,
      };
    },
    close,
  };
}

/** Only a swap-invalidated attempt is replayed. Errors and missing probes stop, never count as zero. */
export async function runMeasuredSeries(
  label,
  work,
  {
    preparation,
    read = readMemorySnapshot,
    monitor = startSwapMonitor,
    persist = save,
    maxAttempts = 3,
  } = {},
) {
  safeLabel(label);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw fail('INVALID_RETRY_LIMIT');
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const path = `.local/measurement-hygiene/${label}-attempt-${attempt}-${randomUUID()}.json`;
    const evidence = { protocol: memoryProtocol, label, attempt, preparation, status: 'pending' };
    let probe, outcomeError;
    try {
      // Refuse before starting the probe, and recheck after its small admission cost.
      assertMemoryStage(read(), 'after-preparation');
      probe = await monitor();
      evidence.before = read();
      assertMemoryStage(evidence.before, 'after-preparation');
      evidence.workStartedAt = Date.now();
      const result = await work();
      evidence.workEndedAt = Date.now();
      evidence.swap = await probe.finish();
      evidence.after = read();
      Object.assign(evidence.swap, {
        workStartedAt: evidence.workStartedAt,
        workEndedAt: evidence.workEndedAt,
      });
      evidence.assessment = assessSwap(evidence.swap, evidence.before, evidence.after);
      evidence.result = result; // Retain discarded samples too; never pool them into accepted p95.
      evidence.status = evidence.assessment.valid ? 'valid' : 'invalid';
      attempts.push({ path, status: evidence.status, reason: evidence.assessment.reason });
      if (!evidence.assessment.valid && evidence.assessment.reason !== 'SWAP_ACTIVITY')
        throw fail(evidence.assessment.reason);
      if (!evidence.assessment.valid)
        console.log(
          JSON.stringify({
            invalidated: label,
            attempt,
            reason: 'SWAP_ACTIVITY',
            replay: attempt < maxAttempts,
            path,
          }),
        );
    } catch (error) {
      evidence.status = 'error';
      evidence.error = error.message;
      if (error.observation) evidence.refusedObservation = error.observation;
      outcomeError = error;
    }
    try {
      if (probe) await probe.close();
    } catch (error) {
      evidence.status = 'error';
      evidence.cleanupError = error.message;
      outcomeError ??= error;
    }
    await persist(path, evidence);
    console.log(
      JSON.stringify({
        hygiene: path,
        status: evidence.status,
        label,
        attempt,
        before: evidence.before,
        after: evidence.after,
        assessment: evidence.assessment,
      }),
    );
    if (outcomeError) throw outcomeError;
    if (evidence.assessment.valid)
      return {
        result: evidence.result,
        hygiene: {
          path,
          attempts,
          before: evidence.before,
          after: evidence.after,
          assessment: evidence.assessment,
        },
      };
  }
  throw fail('SWAP_RETRY_EXHAUSTED', attempts);
}
