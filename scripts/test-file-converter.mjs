import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { converterFixture } from './file-converter-fixture.mjs';

await test(
  'permanent converter: actual kernel confinement, expiry and restart',
  { timeout: 90000 },
  async (t) => {
    const f = await converterFixture();
    t.after(() => f.close());
    const inspect = () => JSON.parse(f.docker(['inspect', f.name]))[0];
    await t.test('Compose hardening, exclusive mount, no credentials or Docker socket', () => {
      const c = inspect();
      assert.equal(c.HostConfig.NetworkMode, 'none');
      assert.equal(c.HostConfig.ReadonlyRootfs, true);
      assert.equal(c.Config.User, '1000:1000');
      assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
      assert(c.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
      assert.equal(c.HostConfig.Memory, 512 * 1024 ** 2);
      assert.equal(c.HostConfig.MemorySwap, c.HostConfig.Memory);
      assert.equal(c.HostConfig.NanoCpus, 1e9);
      assert.equal(c.Mounts.length, 1);
      assert.equal(c.Mounts[0].Destination, '/exchange');
      assert(
        c.Config.Env.every((e) => !/SECRET|PASSWORD|TOKEN|S3_|DATABASE_URL|DOCKER_HOST/.test(e)),
      );
    });
    await t.test(
      'TCP external/loopback/IPv6, UDP and UNIX sockets all denied by the inherited filter',
      () => {
        const code = `const assert=require('node:assert/strict'),net=require('node:net'),dgram=require('node:dgram');
  (async()=>{for(const address of [{host:'1.1.1.1',port:443},{host:'127.0.0.1',port:1},{host:'::1',port:1},{path:'/var/run/docker.sock'}])
   await new Promise((resolve,reject)=>{const s=net.connect(address);s.once('connect',()=>reject(Error('NETWORK_OPEN')));s.once('error',e=>{assert.equal(e.code,'EPERM');resolve();});});
   await new Promise(resolve=>{const s=dgram.createSocket('udp4');s.once('error',e=>{assert.equal(e.code,'EPERM');s.close();resolve();});s.bind(0);});
   console.log('ALL_SOCKETS_DENIED');})().catch(()=>process.exit(1));`;
        assert.match(
          f.docker(['exec', f.name, '/validator/isolate', '--supervisor', 'node', '-e', code]),
          /ALL_SOCKETS_DENIED/,
        );
        // PID 1 itself has both Docker's seccomp and our inherited no-socket filter.
        const servicePid = f
          .docker([
            'exec',
            f.name,
            'node',
            '-e',
            "const fs=require('node:fs');for(const p of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');if(a[0]==='node'&&a.includes('/validator/service.mjs'))console.log(p);}catch{}}",
          ])
          .trim();
        assert.match(servicePid, /^\d+$/);
        const status = f.docker(['exec', f.name, 'cat', '/proc/' + servicePid + '/status']);
        assert.match(status, /NoNewPrivs:\s+1/);
        assert.match(status, /Seccomp_filters:\s+[2-9]/);
      },
    );
    await t.test(
      'decoder cannot write exchange/root, create links, or exceed its 12 MiB output tmpfs',
      async () => {
        await writeFile(resolve(f.config.directory, 'probe'), 'synthetic');
        const code = `const fs=require('node:fs'),assert=require('node:assert/strict');
   for(const path of ['/exchange/escape','/validator/escape'])assert.throws(()=>fs.writeFileSync(path,'x'));
   assert.throws(()=>fs.symlinkSync('/exchange/probe','/scratch/link'));
   assert.throws(()=>fs.writeFileSync('/scratch/oversize',Buffer.alloc(13*1024**2)),e=>e.code==='ENOSPC');
   fs.unlinkSync('/scratch/oversize');console.log('FILESYSTEM_CONFINED');`;
        assert.match(
          f.docker([
            'exec',
            f.name,
            '/validator/isolate',
            '--decode',
            '/exchange/probe',
            '/scratch',
            'node',
            '-e',
            code,
          ]),
          /FILESYSTEM_CONFINED/,
        );
        const { unlink } = await import('node:fs/promises');
        await unlink(resolve(f.config.directory, 'probe'));
      },
    );
    const make = async (expiresAt, running = false) => {
      const name = 'job-' + randomUUID(),
        path = resolve(f.config.directory, name);
      await mkdir(path);
      await mkdir(resolve(path, 'input'));
      await mkdir(resolve(path, 'output'));
      await writeFile(
        resolve(path, 'owner.json'),
        JSON.stringify({ protocol: 2, job: name, expiresAt }),
      );
      await writeFile(resolve(path, 'input/source'), 'synthetic');
      if (running)
        await writeFile(
          resolve(path, 'running.json'),
          JSON.stringify({ protocol: 2, job: name, nonce: 'a'.repeat(64), expiresAt, bytes: 9 }),
        );
      return { name, path };
    };
    const wait = async (fn) => {
      for (let n = 0; n < 100; n++) {
        if (await fn()) return;
        await delay(100);
      }
      throw Error('CONVERTER_RECOVERY_TIMEOUT');
    };
    await t.test(
      'incomplete atomic request is ignored; worker crash leaves an expiring directory',
      async () => {
        const j = await make(Date.now() + 1200);
        await writeFile(resolve(j.path, 'request.json.tmp'), '{partial');
        await delay(500);
        assert(!(await readdir(j.path)).includes('result.json'));
        await wait(async () => !(await stat(j.path).catch(() => null)));
      },
    );
    await t.test(
      'converter SIGKILL restarts automatically; interrupted work is retried, never published',
      async () => {
        // Pause the supervisor so the old running marker is present at actual SIGKILL.
        f.docker(['pause', f.name]);
        const j = await make(Date.now() + 60000, true);
        f.docker(['unpause', f.name]);
        f.docker([
          'exec',
          f.name,
          'node',
          '-e',
          "const fs=require('node:fs');for(const p of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');if(a[0]==='node'&&a.includes('/validator/service.mjs'))process.kill(Number(p),'SIGKILL');}catch{}}",
        ]);
        await wait(async () => {
          try {
            return inspect().RestartCount > 0 && inspect().State.Running;
          } catch {
            return false;
          }
        });
        await wait(async () => !!(await stat(resolve(j.path, 'result.json')).catch(() => null)));
        const r = JSON.parse(await readFile(resolve(j.path, 'result.json'), 'utf8'));
        assert.equal(r.result.status, 'retry');
        assert.deepEqual(r.result.variants, []);
        // Worker-side cleanup of this exact fixture is intentionally left to expiry in production.
      },
    );
  },
);
