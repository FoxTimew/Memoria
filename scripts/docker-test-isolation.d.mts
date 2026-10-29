type Resources = {
  project: string;
  mounts: { type: string; source: string }[];
  ports: string[];
  hostNetwork?: boolean;
};
type Development = { project: string; volumes: string[]; binds: string[]; ports: string[] };
export function assertDockerIsolation(test: Resources, development: Development): void;
export function inspectDevelopment(): Development;
export function guardTestDocker(args: string[]): string[];
