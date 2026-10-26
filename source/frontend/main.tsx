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
  return <Visitor page={path==='/ticket'?'ticket':'home'}/>;
}

createRoot(document.getElementById('root')!).render(<App/>);
