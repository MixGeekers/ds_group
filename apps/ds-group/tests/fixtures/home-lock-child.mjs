// Local subprocess fixture: pause the real filesystem boundary that was racy in
// the legacy lock, without replacing SQLite or the OS process lifetime.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [filename, encodedOptions = '{}'] = process.argv.slice(2);
const options = JSON.parse(encodedOptions);
const originalUnlink = fs.unlinkSync;
const originalOpen = fs.openSync;
const originalClose = fs.closeSync;
const originalWrite = fs.writeFileSync;
const originalLink = fs.linkSync;
const pidDescriptors = new Set();
const wait = new Int32Array(new SharedArrayBuffer(4));
let paused = false, failed = false;
const pause = () => {
  originalWrite(options.pauseMarker, 'paused');
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(options.resumeMarker)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lock test resume');
    Atomics.wait(wait, 0, 0, 5);
  }
};
fs.unlinkSync = (path, ...args) => {
  if (options.pauseUnlink && path === filename && !paused) { paused = true; pause(); }
  return originalUnlink(path, ...args);
};
fs.linkSync = (source, target, ...args) => {
  if (options.pausePublish && target === `${filename}.sqlite` && !paused) { paused = true; pause(); }
  return originalLink(source, target, ...args);
};
fs.openSync = (path, ...args) => {
  const fd = originalOpen(path, ...args);
  if (typeof path === 'string' && path.startsWith(`${filename}.`) && path.endsWith('.tmp') && !path.startsWith(`${filename}.sqlite.`)) pidDescriptors.add(fd);
  return fd;
};
fs.closeSync = (fd, ...args) => { pidDescriptors.delete(fd); return originalClose(fd, ...args); };
fs.writeFileSync = (path, content, ...args) => {
  if (options.failPidWrite && pidDescriptors.has(path) && !failed) {
    failed = true;
    if (options.failPidWrite === 'partial') originalWrite(path, '{"pid":');
    throw Object.assign(new Error('Injected PID write failure'), { code: 'EACCES' });
  }
  return originalWrite(path, content, ...args);
};
syncBuiltinESMExports();
const { homeLock } = await import('../../vendor/ds-bot/src/host/home-lock.js');
const lock = homeLock(filename);
process.on('message', ({ id, command }) => {
  try {
    let holder;
    if (command === 'claim') holder = lock.claim();
    else if (command === 'release') lock.release();
    else if (command !== 'inspect') throw new Error(`Unknown command: ${command}`);
    process.send({ id, accepted: command === 'claim' ? holder === undefined : undefined, holder,
      owns: lock.owns(), record: lock.read(), pid: process.pid });
  } catch (error) { process.send({ id, error: { message: error.message, code: error.code } }); }
});
process.on('disconnect', () => { lock.release(); process.exit(0); });
process.send({ ready: true });
