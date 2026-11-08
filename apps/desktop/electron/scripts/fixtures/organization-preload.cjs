const { ipcRenderer } = require('electron');
// Test-only bridge: renders the production bundle without launching agents,
// changing MCP configs, or using a real GitHub account.
window.letagentsDesktop = new Proxy({}, {
  has() { return true; },
  get(_target, namespace) {
    if (namespace === 'then') return undefined;
    return new Proxy({}, {
      has() { return true; },
      get(_object, method) {
        if (method === 'then') return undefined;
        if (namespace === 'organizations' && method === 'onInvited') return (callback) => {
          const listener = (_event, id) => callback(id);
          ipcRenderer.on('fixture:invite', listener);
          return () => ipcRenderer.off('fixture:invite', listener);
        };
        if (String(method).startsWith('on')) return () => () => {};
        return (...args) => ipcRenderer.invoke('fixture:call', `${namespace}.${method}`, args);
      },
    });
  },
});
