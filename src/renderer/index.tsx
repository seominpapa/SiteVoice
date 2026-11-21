import { createRoot } from 'react-dom/client';
import { Dashboard } from './Dashboard';
import { Overlay } from './Overlay';
import './styles.css';

const overlay = window.location.hash === '#overlay';
if (overlay) document.documentElement.classList.add('overlay-document');
createRoot(document.getElementById('root')!).render(overlay ? <Overlay/> : <Dashboard/>);
