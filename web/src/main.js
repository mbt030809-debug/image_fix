import { App } from './app.js';

function start() {
  const root = document.getElementById('app');
  window.imagefix = new App(root);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
