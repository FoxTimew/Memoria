import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const forbidden = /(^|\/)(\.env(?:\..*)?|credentials[^/]*|\.aws)(\/|$)|\.(pem|key|p12|pfx)$/i;
const secret =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/;
const failures = [];
for (const file of files) {
  if (
    (forbidden.test(file) && !file.endsWith('.env.example')) ||
    file.startsWith('.github/workflows/')
  ) {
    failures.push(file);
    continue;
  }
  const content = execFileSync('git', ['show', `:${file}`], { maxBuffer: 20 * 1024 * 1024 });
  if (!content.includes(0) && secret.test(content.toString('utf8'))) failures.push(file);
}
if (failures.length) {
  console.error(`Commit blocked: inspect these paths (contents withheld):\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.info(
    `Checked ${files.length} staged files for forbidden paths and recognizable credentials. Review remains necessary.`,
  );
}
