// Exercises real VM implementations with disposable manifests, fake HTTP and a
// controlled clock. No production configuration or external services are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-resource-cleanup-'));
const quiet = { log() {}, warn() {}, error() {} };
const compiled = new Map();
let passed = 0, fixtures = 0;

function harness(unsafe) {
  const timers = new Map(), cleared = [], requests = [], modules = new Map();
  let nextId = 0;
  const dataPath = path.join(scratch, String(++fixtures));
  const sourceRoot = path.join(dataPath, 'source');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const clock = {
    add(callback, delay, repeat, args) { const id = ++nextId; timers.set(id, { callback, delay, repeat, args }); return id; },
    clear(id) { cleared.push(Number(id)); timers.delete(Number(id)); },
    run(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay || !timers.has(id)) continue;
        if (!timer.repeat) timers.delete(id);
        timer.callback(...timer.args);
      }
    }
  };
  const needle = {
    request(method, url, data, options, callback) {
      const request = { aborted: false, aborts: 0, abort() { this.aborted = true; this.aborts++; callback(new Error('aborted')); } };
      requests.push({ request, options, reply: (body = { value: 'fixture' }) => callback(null, { statusCode: 200, statusMessage: 'OK', headers: {} }, body) });
      return { request };
    }
  };
  const globals = {
    console: quiet, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
    global: { lx: { config: { 'system.allowUnsafeVM': true } } },
    process: { env: { DATA_PATH: dataPath }, cwd: () => root, on() {} },
    setTimeout: (fn, delay, ...args) => clock.add(fn, delay, false, args),
    setInterval: (fn, delay, ...args) => clock.add(fn, delay, true, args),
    clearTimeout: id => clock.clear(id), clearInterval: id => clock.clear(id),
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    if (!compiled.has(file)) {
      let source = fs.readFileSync(path.join(root, file), 'utf8');
      if (file.endsWith('customSourceHandlers.ts')) source += '\nexport { getScriptInfo };';
      compiled.set(file, ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      } }).outputText);
    }
    const context = vm.createContext({ ...globals, exports: {}, require: id => {
      if (id === 'needle') return needle;
      if (id === 'fs') return { ...fs, watch: () => ({ close() {} }) };
      if (id === './sourceRuntime') return load('src/server/sourceRuntime.ts');
      if (id === './userApi') return load('src/server/userApi.ts');
      return require(id);
    } });
    vm.runInContext(compiled.get(file), context, { filename: file });
    modules.set(file, context.exports);
    return context.exports;
  }
  const api = load('src/server/userApi.ts');
  const source = (script, extra = {}) => ({ id: 'fixture.js', name: 'Resource fixture', version: 1,
    description: '', author: '', homepage: '', sources: {}, script, owner: 'shared', enabled: true, allowUnsafeVM: unsafe, ...extra });
  const manifest = (script, enabled = true) => {
    fs.writeFileSync(path.join(sourceRoot, 'fixture.js'), script);
    fs.writeFileSync(path.join(sourceRoot, 'sources.json'), JSON.stringify([
      { id: 'fixture.js', name: 'Resource fixture', enabled, allowUnsafeVM: unsafe, supportedSources: ['wy'] }
    ]));
  };
  return { api, source, load, timers, cleared, clock, requests, manifest, sourceRoot };
}
const ready = 'lx.send("inited", { sources: { wy: {} } });';
const repeating = `setInterval(() => {}, 60000); lx.on("request", () => "fixture"); ${ready}`;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  for (const unsafe of [false, true]) {
    const mode = unsafe ? 'native VM' : 'vm2';
    await check(`${mode}: 25 reloads retain exactly one source timer`, async () => {
      const h = harness(unsafe);
      let previous;
      for (let i = 0; i < 25; i++) {
        const result = await h.api.loadUserApi(h.source(repeating));
        assert.equal(result.success, true, result.error);
        assert.equal(h.api.getLoadedApis().length, 1);
        assert.equal(h.timers.size, 1, 'old timers and completed initialization deadlines must be removed');
        assert.equal(await result.apiInstance.callRequest('musicUrl', 'wy', {}), 'fixture');
        if (previous) await assert.rejects(previous.callRequest('musicUrl', 'wy', {}), /已卸载/);
        previous = result.apiInstance;
      }
      previous.dispose(); previous.dispose();
      assert.equal(h.timers.size, 0);
      assert.equal(h.api.getLoadedApis().length, 0);
    });

    await check(`${mode}: validation and analysis release their temporary VMs`, async () => {
      const h = harness(unsafe), handlers = h.load('src/server/customSourceHandlers.ts');
      handlers.setAuthChecker(() => true);
      for (let i = 0; i < 10; i++) {
        const info = await handlers.getScriptInfo(repeating, unsafe);
        assert.equal(info.supportedSources.join(','), 'wy');
        const req = new EventEmitter();
        const res = { writeHead() {}, end(body) { this.body = JSON.parse(body); } };
        const validation = handlers.handleValidate(req, res);
        req.emit('data', Buffer.from(JSON.stringify({ script: repeating, allowUnsafeVM: unsafe })));
        req.emit('end');
        await validation;
        assert.equal(res.body.valid, true);
        assert.equal(res.body.sources.join(','), 'wy');
        assert.equal(h.api.getLoadedApis().length, 0);
        assert.equal(h.timers.size, 0);
      }
    });

    await check(`${mode}: failed replacement disposes only the failed instance`, async () => {
      const h = harness(unsafe);
      const original = await h.api.loadUserApi(h.source(repeating));
      const failure = await h.api.loadUserApi(h.source('setInterval(() => {}, 60000); lx.request("https://fixture.invalid", {}, () => {}); throw new Error("fixture failure");'));
      assert.equal(failure.success, false);
      assert.match(failure.error, /fixture failure/);
      assert.equal(h.timers.size, 1);
      assert.equal(h.requests[0].request.aborts, 1);
      assert.equal(await original.apiInstance.callRequest('musicUrl', 'wy', {}), 'fixture');
      original.apiInstance.dispose();
    });

    await check(`${mode}: missing initialization and never-settling scripts release resources`, async () => {
      for (const ending of ['', 'new Promise(() => {});']) {
        const h = harness(unsafe);
        const pending = h.api.loadUserApi(h.source('setInterval(() => {}, 60000); ' + ending));
        h.clock.run(3000);
        const result = await pending;
        assert.equal(result.success, false);
        assert.match(result.error, /初始化超时/);
        assert.equal(h.timers.size, 0);
        assert.equal(h.api.getLoadedApis().length, 0);
      }
    });

    await check(`${mode}: unloading aborts HTTP and rejects waiting callers`, async () => {
      const h = harness(unsafe);
      const result = await h.api.loadUserApi(h.source(`lx.on("request", () => new Promise((resolve, reject) => lx.request("https://fixture.invalid", { timeout: 100 }, (error, response, body) => error ? reject(error) : resolve(body.value)))); ${ready}`));
      assert.equal(result.success, true, result.error);
      const pending = result.apiInstance.callRequest('musicUrl', 'wy', {});
      const rejection = assert.rejects(pending, /已卸载/);
      assert.equal(h.requests[0].options.read_timeout, 100);
      result.apiInstance.dispose();
      await rejection;
      assert.equal(h.requests[0].request.aborts, 1);
      h.requests[0].reply();
      assert.equal(h.timers.size, 0);
    });

    await check(`${mode}: completed HTTP requests are removed before disposal`, async () => {
      const h = harness(unsafe);
      const result = await h.api.loadUserApi(h.source(`lx.on("request", () => new Promise((resolve, reject) => lx.request("https://fixture.invalid", {}, (error, response, body) => error ? reject(error) : resolve(body.value)))); ${ready}`));
      const pending = result.apiInstance.callRequest('musicUrl', 'wy', {});
      h.requests[0].reply();
      assert.equal(await pending, 'fixture');
      result.apiInstance.dispose();
      assert.equal(h.requests[0].request.aborts, 0);
    });

    await check(`${mode}: full reload, disable and source-directory removal clean old VMs`, async () => {
      const h = harness(unsafe);
      h.manifest(repeating);
      await Promise.all(Array.from({ length: 5 }, () => h.api.initUserApis('shared')));
      assert.equal(h.timers.size, 1);
      assert.equal(h.api.getLoadedApis().length, 1);
      h.manifest(repeating, false);
      await h.api.initUserApis('shared');
      assert.equal(h.timers.size, 0);
      assert.equal(h.api.getLoadedApis().length, 0);
      assert.equal(h.api.getApiStatus('shared', 'fixture.js'), undefined);
      h.manifest(repeating);
      await h.api.initUserApis();
      fs.renameSync(h.sourceRoot, h.sourceRoot + '-removed');
      await h.api.initUserApis();
      assert.equal(h.timers.size, 0);
      assert.equal(h.api.getLoadedApis().length, 0);
    });
  }

  await check('Timer callbacks preserve arguments, clear operations and nextTick cleanup', async () => {
    const h = harness(true);
    const result = await h.api.loadUserApi(h.source(`
      let value = '';
      setTimeout((a, b) => { value = a + b; }, 20, 'a', 'b');
      const interval = setInterval(() => {}, 40); clearTimeout(interval);
      const timeout = setTimeout(() => {}, 40); clearInterval(timeout);
      process.nextTick(() => { value += 'c'; });
      lx.on('request', () => value); ${ready}
    `));
    assert.equal(result.success, true, result.error);
    assert.equal(h.timers.size, 2);
    h.clock.run(20); h.clock.run(0);
    assert.equal(await result.apiInstance.callRequest('musicUrl', 'wy', {}), 'abc');
    const cleared = h.cleared.length;
    result.apiInstance.dispose();
    assert.equal(h.cleared.length, cleared, 'fired timers must not remain in the runtime tracker');
    assert.equal(h.timers.size, 0);
  });
  console.log(`\n${passed} resource cleanup checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});
