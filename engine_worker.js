'use strict';

let requestStarted = false;

self.onmessage = ({ data }) => {
  if (requestStarted || !data || typeof data.fen !== 'string') return;
  requestStarted = true;

  const commands = [
    'uci',
    'isready',
    `position fen ${data.fen}`,
    data.depth > 0 ? `go depth ${data.depth}` : `go movetime ${data.timeLimitMs || 3000}`,
    'quit',
  ].join('\n') + '\n';
  let inputOffset = 0;

  var Module = {
    noInitialRun: true,
    locateFile: path => data.assets[path] || path,
    stdin: () => {
      if (inputOffset >= commands.length) return null;
      return commands.charCodeAt(inputOffset++);
    },
    print: line => {
      const match = String(line).match(/^bestmove\s+(\S+)/);
      if (match) {
        self.postMessage({ type: 'bestmove', move: match[1] });
        self.close();
      }
    },
    printErr: line => {
      if (/error|fatal/i.test(String(line))) {
        self.postMessage({ type: 'error', error: String(line) });
      }
    },
    onRuntimeInitialized: () => {
      const startEngine = () => {
        if (!Module.FS || typeof Module.callMain !== 'function') {
          setTimeout(startEngine, 0);
          return;
        }
        try {
          Module.FS.close(0);
          Module.FS.writeFile('/uci-input', commands);
          Module.FS.open('/uci-input', 'r');
          Module.callMain([]);
        } catch (error) {
          self.postMessage({ type: 'error', error: error.message });
        }
      };
      startEngine();
    },
  };

  self.Module = Module;
  try {
    importScripts(data.engineScriptUrl);
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message });
  }
};
