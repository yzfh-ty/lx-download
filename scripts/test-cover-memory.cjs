// Repeat actual cover parsing with a 1 MiB embedded image. Forced GC is used only
// in this test to distinguish retained allocations from ordinary transient data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: idle } = require('node:timers/promises');
const ts = require('typescript');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cover-memory-'));
const source = fs.readFileSync(path.join(__dirname, '../src/server/embeddedCover.ts'), 'utf8');
const context = vm.createContext({ exports: {}, Buffer, require: name => name === 'music-metadata'
  ? { parseFile: (...args) => import('music-metadata').then(api => api.parseFile(...args)) }
  : require(name) });
vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { readEmbeddedCover } = context.exports;
const mib = bytes => Math.round(bytes / 1048576 * 100) / 100;

async function main() {
  assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2kAAAAASUVORK5CYII=', 'base64');
  const image = Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)]);
  const tags = require('node-id3').create({ title: 'Memory fixture', image: { mime: 'image/png', type: { id: 3 }, description: '', imageBuffer: image } });
  const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x64]);
  const file = path.join(scratch, 'fixture.mp3');
  fs.writeFileSync(file, Buffer.concat([tags, ...Array.from({ length: 100 }, () => frame)]));
  const read = async () => {
    const cover = await readEmbeddedCover(file);
    assert(cover, 'fixture must contain readable artwork');
    assert.equal(cover.mime, 'image/png');
    assert(cover.data.equals(image), 'cover bytes must survive parsing unchanged');
  };
  for (let i = 0; i < 20; i++) await read();
  global.gc(); await idle(); global.gc();
  const before = process.memoryUsage();
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 20; i++) await read();
    global.gc(); await idle();
  }
  global.gc(); await idle(); global.gc();
  const after = process.memoryUsage();
  const rssGrowth = after.rss - before.rss;
  const externalGrowth = after.external - before.external;
  assert(rssGrowth < 64 * 1048576, `RSS grew ${mib(rssGrowth)} MiB after 400 reads`);
  assert(externalGrowth < 16 * 1048576, `External memory grew ${mib(externalGrowth)} MiB`);
  console.log(`PASS 400 repeated 1 MiB cover reads: RSS growth ${mib(rssGrowth)} MiB; external growth ${mib(externalGrowth)} MiB`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});
