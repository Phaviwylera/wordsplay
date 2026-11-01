'use strict';

// This command contacts the already-running worker. It never starts another
// worker and never opens the SQLite database itself.
const net = require('node:net');
const readline = require('node:readline/promises');
const { stdin, stdout, stderr } = require('node:process');
const { socketPath } = require('./file-job-recovery');

function controlRequest(filename, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: filename });
    let response = ''; let settled = false;
    const fail = () => { if (!settled) { settled = true; socket.destroy(); reject(new Error('Private recovery control unavailable')); } };
    socket.setEncoding('utf8');
    socket.setTimeout(5000, fail);
    socket.once('error', fail);
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', chunk => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > 20000) return fail();
      const newline = response.indexOf('\n');
      if (newline < 0 || settled) return;
      settled = true;
      socket.destroy();
      try { resolve(JSON.parse(response.slice(0, newline))); } catch (_) { reject(new Error('Invalid recovery response')); }
    });
    socket.once('end', () => { if (!settled) fail(); });
  });
}

async function main() {
  const directory = process.env.WALLETO_BACKGROUND_DIR;
  if (!directory) throw new Error('The private EC2 worker is not enabled in this container.');
  const filename = socketPath(directory);
  const listing = await controlRequest(filename, { action: 'list' });
  if (!listing?.ok || !Array.isArray(listing.jobs)) throw new Error('Could not list EC2 file jobs.');
  const jobs = listing.jobs.filter(job => /^[a-f0-9]{64}$/.test(job.id || '') && typeof job.createdAt === 'string' && ['importing', 'scanning', 'finished', 'failed'].includes(job.status));
  if (!jobs.length) { stdout.write('No recoverable file jobs were found.\n'); return; }
  stdout.write('EC2 file jobs (creation time is UTC):\n');
  jobs.forEach((job, index) => stdout.write(`  ${index + 1}. ${job.createdAt}  ${job.status}\n`));
  stdout.write('\nA new code lets this browser reconnect and invalidates older browser links for the selected job when redeemed.\n');
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let answer;
  try { answer = (await prompt.question('Choose a job number (or press Enter to cancel): ')).trim(); }
  finally { prompt.close(); }
  if (!answer) { stdout.write('Cancelled; no job access was changed.\n'); return; }
  if (!/^[1-9]\d*$/.test(answer) || Number(answer) > jobs.length) throw new Error('Invalid job number; no job access was changed.');
  const issued = await controlRequest(filename, { action: 'issue', id: jobs[Number(answer) - 1].id });
  if (!issued?.ok || !/^[a-f0-9]{64}$/.test(issued.code || '')) throw new Error('Could not create a code; the job may no longer exist.');
  stdout.write('\nOne-time recovery code (expires in 10 minutes):\n');
  stdout.write(`${issued.code}\n`);
  stdout.write('Paste it only into Reconnect existing file job in your private Walleto dashboard. Never share the code or recovery phrases.\n');
}

if (require.main === module) main().catch(error => { stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { controlRequest, main };
