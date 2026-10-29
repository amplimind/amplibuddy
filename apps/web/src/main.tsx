import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Admin } from './Admin.tsx';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.replace(/\/+$/, '') === '/admin' ? <Admin /> : <App />}
  </StrictMode>,
);
