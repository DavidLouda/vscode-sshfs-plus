import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import './index.css';
import { STORE } from './redux';
import Router from './router';
import { API } from './vscode';

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <Provider store={STORE}>
    <div className="App">
      <Router />
    </div>
  </Provider>
);

API.postMessage({ type: 'requestData' });
