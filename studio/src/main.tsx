import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';

const host = document.getElementById('root');
if (!host) throw new Error('#root missing');
createRoot(host).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
