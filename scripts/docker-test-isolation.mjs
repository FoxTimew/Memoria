import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const fail = (reason) => {
  throw new Error(
    `DOCKER_TEST_ISOLATION: ${reason}. Refusing to start; use a separate test project, volumes and host ports.`,
  );
};
const docker = (args) => {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fail('cannot inspect Docker/development configuration');
  }
};
const pathKey = (p) => p.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
/** Pure policy, also used by real Docker startup. Read-only mounts are not an exception. */
export function assertDockerIsolation(test, development) {
  if (!test.project || test.project === development.project)
    fail('Compose project collides with development');
  if (test.hostNetwork) fail('host networking bypasses port isolation');
  for (const mount of test.mounts) {
    if (mount.type === 'volume' && development.volumes.includes(mount.source))
      fail('development volume mounted (including read-only)');
    if (
      mount.type === 'bind' &&
      development.binds.some((p) => overlaps(pathKey(p), pathKey(mount.source)))
    )
      fail('development bind mount reused or enclosed');
  }
  for (const port of test.ports)
    if (development.ports.includes(String(port))) fail('host port collides with development');
}
function resources(config) {
  const mounts = [],
    ports = [];
  for (const volume of Object.values(config.volumes ?? {}))
    if (volume.driver_opts && Object.keys(volume.driver_opts).length)
      fail('volume driver options may alias development data');
  for (const s of Object.values(config.services ?? {})) {
    for (const v of s.volumes ?? []) {
      if (v.type === 'volume' && v.source)
        mounts.push({ type: 'volume', source: config.volumes?.[v.source]?.name ?? v.source });
      else if (v.type === 'bind') mounts.push({ type: 'bind', source: resolve(v.source) });
    }
    for (const p of s.ports ?? []) if (p.published) ports.push(...portRange(String(p.published)));
    if (s.network_mode === 'host') fail('host network in Compose configuration');
  }
  return { project: config.name, mounts, ports };
}
function portRange(value) {
  if (!/^\d+(?:-\d+)?$/.test(value)) fail('unresolved host port');
  const [a, b = a] = value.split('-').map(Number);
  if (a < 1 || b > 65535 || b < a) fail('invalid host port range');
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
}
export function inspectDevelopment() {
  // Resolve from the calling clone, including an explicit development project override.
  const config = JSON.parse(
    docker(['compose', '-f', resolve('compose.yaml'), 'config', '--format', 'json']),
  );
  const r = resources(config);
  const volumes = Object.values(config.volumes ?? {}).map((v) => v.name);
  const binds = r.mounts.filter((m) => m.type === 'bind').map((m) => m.source),
    ports = r.ports;
  const ids = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + r.project])
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length)
    for (const c of JSON.parse(docker(['inspect', ...ids]))) {
      for (const m of c.Mounts ?? []) {
        if (m.Type === 'volume') volumes.push(m.Name);
        if (m.Type === 'bind' || m.Type === 'volume') binds.push(m.Source);
      }
      for (const bindings of Object.values(c.HostConfig.PortBindings ?? {}))
        for (const p of bindings ?? []) if (p.HostPort) ports.push(p.HostPort);
    }
  return { project: r.project, volumes, binds, ports };
}
/** Guard every run/create/start, and all Compose service starts. Inspection/cleanup is unchanged. */
export function guardTestDocker(args) {
  args = [...args];
  if (args[0] === 'compose' && args.some((a) => ['up', 'run', 'start', 'restart'].includes(a))) {
    const action = args.findIndex((a) => ['up', 'run', 'start', 'restart'].includes(a));
    if (args[action] === 'run')
      fail(
        'Compose run overrides are not supported; use an inspected service configuration with up',
      );
    if (
      args
        .slice(action + 1)
        .some(
          (a) =>
            a.startsWith('-') &&
            !['-d', '--detach', '--build', '--wait', '--no-build', '--no-deps'].includes(a),
        )
    )
      fail('unsupported Compose startup override');
    const options = args.slice(0, action);
    if (!options.includes('-p') && !options.includes('--project-name'))
      fail('test Compose needs an explicit project name');
    const config = JSON.parse(docker([...options, 'config', '--format', 'json']));
    assertDockerIsolation(resources(config), inspectDevelopment());
    return args;
  }
  if (!['run', 'create', 'start', 'restart'].includes(args[0])) return args;
  const development = inspectDevelopment();
  if (['start', 'restart'].includes(args[0])) {
    if (args.length !== 2 || args[1].startsWith('-'))
      fail('start one inspected test container at a time');
    const c = JSON.parse(docker(['inspect', args[1]]))[0];
    assertDockerIsolation(
      {
        project: c.Config.Labels?.['com.docker.compose.project'],
        mounts: (c.Mounts ?? []).map((m) => ({
          type: m.Type,
          source: m.Type === 'volume' ? m.Name : m.Source,
        })),
        ports: Object.values(c.HostConfig.PortBindings ?? {}).flatMap((v) =>
          (v ?? []).flatMap((p) => (p.HostPort ? portRange(p.HostPort) : [])),
        ),
        hostNetwork: c.HostConfig.NetworkMode === 'host',
      },
      development,
    );
    return args;
  }
  const mounts = [],
    ports = [];
  let name,
    project,
    hostNetwork = false;
  const booleans = new Set([
    '--rm',
    '--detach',
    '-d',
    '--read-only',
    '--init',
    '-i',
    '--interactive',
  ]);
  const values = new Set([
    '--name',
    '--publish',
    '-p',
    '--mount',
    '--volume',
    '-v',
    '--label',
    '-l',
    '--network',
    '--memory',
    '--memory-swap',
    '--cpus',
    '--cpuset-cpus',
    '--env',
    '-e',
    '--add-host',
    '--pull',
    '--cap-drop',
    '--security-opt',
    '--user',
    '-u',
    '--workdir',
    '-w',
    '--entrypoint',
    '--tmpfs',
    '--pids-limit',
    '--shm-size',
  ]);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break; // image then its command, never interpreted as Docker flags
    const [option, ...inline] = arg.split('=');
    if (booleans.has(option)) continue;
    if (!values.has(option)) fail('unsupported test Docker flag ' + option);
    let value = inline.length ? inline.join('=') : args[++i];
    if (!value) fail('missing Docker option');
    if (option === '--name') name = value;
    if (['--label', '-l'].includes(option) && value.startsWith('com.docker.compose.project='))
      project = value.slice(27);
    if (option === '--network') hostNetwork = value === 'host' || value.startsWith('container:');
    if (['--publish', '-p'].includes(option)) {
      const parts = value.replace(/\/(tcp|udp)$/, '').split(':');
      if (parts.length < 2 || !parts.at(-2)) {
        let free;
        do {
          free = execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import {createServer} from 'node:net'; const s=createServer(); s.listen(0,'127.0.0.1',()=>{console.log(s.address().port); s.close();});",
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 },
          ).trim();
        } while (development.ports.includes(free));
        value = '127.0.0.1:' + free + ':' + value.split(':').at(-1);
        args[i] = inline.length ? option + '=' + value : value;
        ports.push(...portRange(free));
      }
      if (parts.length > 1 && parts.at(-2)) ports.push(...portRange(parts.at(-2)));
    }
    if (option === '--mount') {
      const m = Object.fromEntries(value.split(',').map((v) => v.split('=')));
      if (
        Object.keys(m).some(
          (k) =>
            !['type', 'source', 'src', 'target', 'dst', 'destination', 'readonly', 'ro'].includes(
              k,
            ),
        )
      )
        fail('mount options must not bypass source isolation');
      const type = m.type ?? 'volume',
        source = m.source ?? m.src;
      if (!['volume', 'bind', 'tmpfs'].includes(type)) fail('unknown mount type');
      if (source) mounts.push({ type, source: type === 'bind' ? resolve(source) : source });
    }
    if (['--volume', '-v'].includes(option)) {
      const match = value.match(/^(.+):\/[^:]+(?::[^:]+)?$/);
      if (!match) fail('use explicit --mount for test volume');
      const source = match[1],
        type = /[\\/]/.test(source) ? 'bind' : 'volume';
      mounts.push({ type, source: type === 'bind' ? resolve(source) : source });
    }
  }
  if (!name || !/^memoria-[a-z0-9-]+$/.test(name))
    fail('explicit memoria test container name required');
  project ??= 'test-' + name;
  const existing = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).split(/\r?\n/));
  for (const mount of mounts.filter((m) => m.type === 'volume' && existing.has(m.source))) {
    const volume = JSON.parse(docker(['volume', 'inspect', mount.source]))[0];
    if (Object.keys(volume.Options ?? {}).length)
      fail('existing volume driver options may alias development data');
  }
  assertDockerIsolation({ project, mounts, ports, hostNetwork }, development);
  // run/create are labelled too, so a later start must undergo the same inspection.
  return [args[0], '--label', 'com.docker.compose.project=' + project, ...args.slice(1)];
}
