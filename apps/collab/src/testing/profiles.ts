import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as Y from 'yjs';
import { contentFixture } from './content-fixture.ts';
import { historyFixture } from './sized-fixture.ts';
export async function loadProfile(profile: string) {
  const path = `.local/incremental/${profile}.bin`;
  try {
    return await readFile(path);
  } catch {
    const fixture =
      profile === 'content-1M' ? await contentFixture() : await historyFixture(1024 ** 2 - 4096);
    try {
      const bytes = Y.encodeStateAsUpdate(fixture.doc);
      await mkdir('.local/incremental', { recursive: true });
      await writeFile(path, bytes);
      return bytes;
    } finally {
      fixture.doc.destroy();
    }
  }
}
