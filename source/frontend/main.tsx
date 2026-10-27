import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Visitor from './visitor';
import Admin from './admin';
import './globals.css';
import './seiriken.css';

function route(){return location.hash.replace(/^#/,'')||'/';}

function App(){
  const [path,setPath]=useState(route());
  useEffect(()=>{const change=()=>setPath(route());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  if(path==='/admin'||path.startsWith('/admin/'))return <Admin/>;
  const event=/^\/e\/(\d+)/.exec(path);
  return <Visitor page={path==='/ticket'||path.startsWith('/t/')?'ticket':'home'} eventId={event?Number(event[1]):null}/>;
}

createRoot(document.getElementById('root')!).render(<App/>);
