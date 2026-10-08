import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import './styles.css';
import { App } from './App';
import { transport } from './lib/api';
import { liveSource } from './lib/live';
import { DEMO } from './lib/env';


async function boot() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (DEMO) {
    root.render(<div className="page muted">Loading Umami Ops demo…</div>);
    const demo = await import('./demo/backend');
    await demo.startDemo();
    transport.request = demo.request;
    liveSource.subscribe = (fn) => {
      const off = demo.onChange(fn);
      return () => void off();
    };
    (window as any).__umamiReset = demo.resetDemo;
  }
  const Router = DEMO ? HashRouter : BrowserRouter;
  root.render(
    <React.StrictMode>
      <Router>
        <App />
      </Router>
    </React.StrictMode>,
  );
}
boot();
