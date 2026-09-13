// Run inside the container: node diagnose-memory.cjs [node-pid]
// Reads the running process, not the memory of this diagnostic Node process.
// A debugger started by this script is closed after sampling. No GC or heap
// snapshot is requested, and no configuration, credentials or song data is read.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const targetPid = Number(process.argv[2] || 1);
const endpoint = 'http://127.0.0.1:9229/json/list';
const expression = `(() => {
  const heap = process.getBuiltinModule('node:v8').getHeapStatistics();
  const mib = bytes => Math.round(bytes / 1048576 * 100) / 100;
  const resources = {};
  for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] || 0) + 1;
  return {
    pid: process.pid, node: process.version, uptimeSeconds: Math.round(process.uptime()),
    memoryMiB: Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, value]) => [key, mib(value)])),
    heapLimitMiB: mib(heap.heap_size_limit), mallocedMiB: mib(heap.malloced_memory),
    nativeContexts: heap.number_of_native_contexts, detachedContexts: heap.number_of_detached_contexts,
    resources
  };
})()`;

async function main() {
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || targetPid === process.pid) throw new Error('目标必须是已经运行的 Node 进程');
  const executable = path.basename(fs.readlinkSync(`/proc/${targetPid}/exe`));
  if (!/^node(?:js)?$/.test(executable)) throw new Error(`PID ${targetPid} 不是 Node 进程，已取消诊断`);
  const targets = async () => {
    try { return await (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).json(); }
    catch { return null; }
  };
  let list = await targets(), opened = false, socket, requestId = 0;
  const pending = new Map();
  const rpc = code => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: code, returnByValue: true } }));
  });
  const timeout = setTimeout(() => {
    for (const { reject } of pending.values()) reject(new Error('诊断超时'));
    socket?.close();
  }, 15000);
  try {
    if (!list) {
      process.kill(targetPid, 'SIGUSR1');
      opened = true;
      for (let attempt = 0; attempt < 30 && !list; attempt++) { await delay(100); list = await targets(); }
    }
    const target = list?.find(item => item.type === 'node' && item.webSocketDebuggerUrl);
    if (!target) throw new Error('无法连接容器内部的 Node 调试端口 9229');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) task.reject(new Error('无法读取目标进程内存'));
      else task.resolve(message.result?.result?.value);
    });
    socket.addEventListener('close', () => {
      for (const { reject } of pending.values()) reject(new Error('诊断连接已关闭'));
      pending.clear();
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('诊断连接失败')), { once: true });
    });
    const result = await rpc(expression);
    if (result?.pid !== targetPid) {
      opened = false; // Never close an inspector belonging to a different process.
      throw new Error('调试端口不属于目标进程，已取消诊断');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      if (opened && socket?.readyState === WebSocket.OPEN) {
        await rpc("setTimeout(() => process.getBuiltinModule('node:inspector').close(), 100); undefined");
      }
    } finally {
      socket?.close();
      clearTimeout(timeout);
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
