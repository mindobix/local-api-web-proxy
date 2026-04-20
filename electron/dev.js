'use strict';

// Dev launcher — spawns Electron with ELECTRON_RUN_AS_NODE deleted so the
// GUI process boots correctly. This is only needed for machines that happen
// to have ELECTRON_RUN_AS_NODE=1 in their shell environment (it breaks
// `electron .` by forcing Electron to run as plain Node).

const path  = require('path');
const { spawn } = require('child_process');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron'); // returns the binary path
const args = [path.resolve(__dirname, '..')];

const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code || 0));
