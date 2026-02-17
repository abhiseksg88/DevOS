"use client";

import { useState, useMemo, useEffect } from "react";
import {
  RefreshCw,
  ExternalLink,
  Smartphone,
  Tablet,
  Monitor,
  Globe,
  Play,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/types";

type ViewportSize = "mobile" | "tablet" | "desktop";

const VIEWPORTS: Record<
  ViewportSize,
  { width: string; icon: typeof Monitor; label: string }
> = {
  mobile: { width: "375px", icon: Smartphone, label: "Mobile" },
  tablet: { width: "768px", icon: Tablet, label: "Tablet" },
  desktop: { width: "100%", icon: Monitor, label: "Desktop" },
};

interface PreviewPaneProps {
  url: string | null;
  files?: FileNode[];
  onError?: (errorMessage: string) => void;
  isGenerating?: boolean;
  tenantId?: string;
  projectId?: string;
  userToken?: string;
}

// ---------------------------------------------------------------------------
// File-tree helpers
// ---------------------------------------------------------------------------

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const n of nodes) {
    if (n.type === "file") result.push(n);
    if (n.children) result.push(...flattenFiles(n.children));
  }
  return result;
}

function collectCSS(files: FileNode[]): string {
  return files
    .filter((f) => f.path.endsWith(".css") && f.content)
    .map((f) => f.content!)
    .join("\n");
}

function findMainFile(files: FileNode[]): string {
  // Helper: check if content is real generated code vs placeholder
  const isRealContent = (f: FileNode) =>
    f.content && !f.content.includes("Your generated code will appear here");

  // Prefer files with real generated content over placeholder
  const main =
    files.find(
      (f) => (f.path.includes("page.tsx") || f.path.includes("page.jsx")) && isRealContent(f)
    ) ??
    files.find(
      (f) => (f.path.includes("App.tsx") || f.path.includes("App.jsx")) && isRealContent(f)
    ) ??
    files.find(
      (f) => (f.path.includes("index.tsx") || f.path.includes("index.jsx")) && isRealContent(f)
    ) ??
    files.find(
      (f) =>
        (f.language === "typescriptreact" ||
          f.language === "javascriptreact") &&
        isRealContent(f)
    ) ??
    // Fallback: accept any matching file including placeholder
    files.find(
      (f) => f.path.includes("page.tsx") || f.path.includes("page.jsx")
    ) ??
    files.find(
      (f) => f.path.includes("App.tsx") || f.path.includes("App.jsx")
    ) ??
    files.find(
      (f) => f.path.includes("index.tsx") || f.path.includes("index.jsx")
    ) ??
    files.find(
      (f) =>
        (f.language === "typescriptreact" ||
          f.language === "javascriptreact") &&
        f.content
    );
  return main?.content ?? "";
}

/** Base64-encode with full Unicode support */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Build preview HTML — "Whole Module" approach
//
// Instead of regex-parsing JSX (which breaks on inline helper components),
// we load React + Babel Standalone in the iframe, transpile the LLM code,
// execute it in a CommonJS module sandbox, and mount the default export
// with ReactDOM.createRoot.  This handles:
//   - Inline helper functions (Header, Hero, etc.) — they're just functions
//   - useState / useEffect / all hooks — real React runtime
//   - Event handlers, ternaries, .map() — real JS execution
//   - TypeScript type annotations — Babel strips them
// ---------------------------------------------------------------------------

function buildPreviewDocument(
  files: FileNode[],
  supabaseUrl?: string,
  supabaseAnonKey?: string,
  tenantId?: string,
  projectId?: string,
  userToken?: string,
): string {
  const allFiles = flattenFiles(files);
  const css = collectCSS(allFiles);
  const mainCode = findMainFile(allFiles);

  const cleanCSS = css
    .replace(/@tailwind\s+\w+;/g, "")
    .replace(/@import\s+[^;]+;/g, "")
    .trim();

  const mainB64 = mainCode ? toBase64(mainCode) : "";

  // Build a registry of component files so require("./components/X") works
  const entries: string[] = [];
  for (const f of allFiles) {
    if (
      !f.content ||
      f.path.includes("layout.") ||
      f.path.includes("page.") ||
      f.path.endsWith(".css") ||
      f.path.endsWith(".json")
    )
      continue;
    if (
      !(
        f.name.endsWith(".tsx") ||
        f.name.endsWith(".jsx") ||
        f.name.endsWith(".ts") ||
        f.name.endsWith(".js")
      )
    )
      continue;

    const b64 = toBase64(f.content);
    const noExt = f.path.replace(/\.(tsx|jsx|ts|js)$/, "");
    const keys = [f.path, noExt];
    if (f.path.startsWith("src/")) {
      keys.push("@/" + f.path.slice(4), "@/" + noExt.slice(4));
      keys.push("./" + f.path.slice(4), "./" + noExt.slice(4));
    }
    for (const k of keys)
      entries.push(`${JSON.stringify(k)}:${JSON.stringify(b64)}`);
  }

  // We build the registry as a raw JS object literal (safe — keys are JSON-escaped)
  const registry = `{${entries.join(",")}}`;

  // Escape Supabase credentials for safe embedding in JS strings
  const safeSupabaseUrl = (supabaseUrl || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeAnonKey = (supabaseAnonKey || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeTenantId = (tenantId || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeProjectId = (projectId || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeUserToken = (userToken || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  /* ------------------------------------------------------------------ */
  /* The HTML document loaded inside the preview iframe                  */
  /* ------------------------------------------------------------------ */
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>

<!-- 1. Error bridge — must be FIRST so it catches load errors from CDNs -->
<script>
window.__errs=[];
/* postMessage to parent uses '*' because srcdoc iframes are same-origin;
   only non-sensitive diagnostic messages (errors, logs) are sent this way.
   Credential messages (SUPABASE_INIT) are handled separately with origin checks. */
window.onerror=function(m,s,l,c,e){
  var p={message:String(m),line:l,stack:e?e.stack:''};
  window.__errs.push(p);
  try{window.parent.postMessage({type:'PREVIEW_ERROR',payload:p},'*')}catch(x){}
};
window.onunhandledrejection=function(e){
  var m=e.reason?(e.reason.message||String(e.reason)):'Unhandled rejection';
  try{window.parent.postMessage({type:'PREVIEW_ERROR',payload:{message:m}},'*')}catch(x){}
};
var _ce=console.error;
console.error=function(){
  _ce.apply(console,arguments);
  try{window.parent.postMessage({type:'PREVIEW_LOG',payload:{level:'error',args:Array.from(arguments).map(String)}},'*')}catch(x){}
};
<\/script>

<!-- 2. React 18 UMD -->
<script crossorigin src="https://unpkg.com/react@18.2.0/umd/react.development.js"><\/script>
<script crossorigin src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.development.js"><\/script>

<!-- 3. Babel Standalone — transpiles JSX + TypeScript in-browser -->
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"><\/script>

<!-- 4. Tailwind CSS CDN -->
<script src="https://cdn.tailwindcss.com"><\/script>

<!-- 5. Supabase Client SDK (for data persistence) -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"><\/script>

<style>
html,body,#root{height:100%;width:100%;margin:0;padding:0;overflow-x:hidden}
*,*::before,*::after{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
#root{display:flex;flex-direction:column;min-height:100%}
${cleanCSS}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function(){
  /* --- Core state --- */
  window.__supabase_ready=false;
  window.__sb_resolve=null;
  window.__sb_promise=new Promise(function(r){window.__sb_resolve=r});
  window.__VEDAA_TENANT_ID="${safeTenantId}";
  window.__VEDAA_PROJECT_ID="${safeProjectId}";
  window.__VEDAA_APP_INSTANCE_ID="${safeProjectId||'preview'}";
  var __sbUrl="${safeSupabaseUrl}";
  var __sbKey="${safeAnonKey}";
  var __sbToken="${safeUserToken}";

  /* ================================================================
     RESPONSE NORMALIZER (defined FIRST so basic init can use it)
     Wraps supabase.from() chains so that:
     1. {data: null} → {data: []}  for list queries
     2. Response objects get array methods (map, filter, etc.)
        that delegate to response.data
     ================================================================ */
  var __arrayMethods='map,filter,find,findIndex,forEach,some,every,reduce,reduceRight,includes,indexOf,lastIndexOf,flat,flatMap,slice,sort,concat,join,splice,push,pop,shift,unshift,reverse,fill,copyWithin,entries,keys,values,at,toString'.split(',');
  function __enrichResult(result){
    if(!result||typeof result!=='object'||!Array.isArray(result.data)) return result;
    var arr=result.data;
    __arrayMethods.forEach(function(m){
      if(typeof arr[m]==='function'&&!(m in result)){
        result[m]=function(){return arr[m].apply(arr,arguments)};
      }
    });
    if(!('length' in result)){
      Object.defineProperty(result,'length',{get:function(){return arr.length},configurable:true,enumerable:false});
    }
    try{if(typeof Symbol!=='undefined'&&Symbol.iterator&&!(Symbol.iterator in result)){result[Symbol.iterator]=function(){return arr[Symbol.iterator]()};}}catch(x){}
    return result;
  }
  function __wrapSB(client){
    if(!client||!client.from) return client;
    var _origFrom=client.from.bind(client);
    client.from=function(table){
      return __wrapChain(_origFrom(table),false);
    };
    return client;
  }
  function __wrapChain(builder,isSingle){
    if(!builder||typeof builder!=='object') return builder;
    return new Proxy(builder,{
      get:function(target,prop){
        if(prop==='then'){
          var origThen=target.then;
          if(typeof origThen!=='function') return origThen;
          return function(onRes,onRej){
            return origThen.call(target,function(result){
              if(result&&result.data===null&&!isSingle){
                result={data:[],error:result.error,count:result.count,status:result.status,statusText:result.statusText};
              }
              if(!isSingle) __enrichResult(result);
              return onRes?onRes(result):result;
            },onRej);
          };
        }
        var val=target[prop];
        if(typeof val==='function'){
          return function(){
            var next=val.apply(target,arguments);
            var nextSingle=isSingle||(prop==='single')||(prop==='maybeSingle');
            if(next&&typeof next==='object'&&typeof next.then==='function'){
              return __wrapChain(next,nextSingle);
            }
            return next;
          };
        }
        return val;
      }
    });
  }

  /* ================================================================
     IMMEDIATE INIT — use baked-in credentials (NEXT_PUBLIC_* are public)
     This eliminates the postMessage roundtrip that caused
     "Database connection unavailable" on 8s timeout.
     ================================================================ */
  if(__sbUrl&&__sbKey&&typeof supabase!=='undefined'&&supabase.createClient){
    try{
      var _initOpts={};
      if(__sbToken){
        _initOpts.global={headers:{Authorization:'Bearer '+__sbToken}};
      }
      var _basicClient=supabase.createClient(__sbUrl,__sbKey,_initOpts);
      window.supabase=__wrapSB(_basicClient);
      window.__supabase_ready=true;
      window.__sb_resolve(_basicClient);
      console.log('[Preview] Supabase initialized'+ (__sbToken?' (authenticated)':' (anon)') +':', __sbUrl);

      /* === DB Health Check — verify app_data table + RLS access === */
      (async function(){
        try{
          var r=await _basicClient.from('app_data').select('id').limit(1);
          if(r.error){
            console.error('[Preview DB] app_data table check FAILED:',r.error.message,r.error.code);
            if(r.error.message.indexOf('does not exist')!==-1||r.error.code==='42P01'){
              console.error('[Preview DB] TABLE MISSING — attempting auto-creation via /api/db-setup...');
              try{
                var setupResp=await fetch('/api/db-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
                var setupResult=await setupResp.json();
                if(setupResult.success){
                  console.log('[Preview DB] Auto-creation:',setupResult.message);
                  /* Re-check after creation */
                  var r2=await _basicClient.from('app_data').select('id').limit(1);
                  if(r2.error){
                    console.error('[Preview DB] Table created but access denied:',r2.error.message,'— RLS may be blocking. Ensure user is authenticated.');
                  }else{
                    console.log('[Preview DB] app_data table: OK (auto-created)');
                  }
                }else{
                  console.error('[Preview DB] Auto-creation failed:',setupResult.error);
                  console.error('[Preview DB] Run manually: supabase db push (migration 004_app_data_table.sql)');
                }
              }catch(setupErr){
                console.error('[Preview DB] Auto-creation request failed:',setupErr);
              }
            }else if(r.error.code==='42501'||r.error.message.indexOf('permission denied')!==-1){
              console.error('[Preview DB] RLS DENIED — User auth token may be missing or expired. tenant_id:',window.__VEDAA_TENANT_ID);
            }
          }else{
            console.log('[Preview DB] app_data table: OK (',r.data?r.data.length:0,'rows accessible)');
          }
          console.log('[Preview DB] Globals — tenant_id:',window.__VEDAA_TENANT_ID||'EMPTY','project_id:',window.__VEDAA_PROJECT_ID||'EMPTY');
          if(!window.__VEDAA_TENANT_ID) console.error('[Preview DB] WARNING: __VEDAA_TENANT_ID is empty — all INSERT operations will fail RLS');
          if(!window.__VEDAA_PROJECT_ID) console.error('[Preview DB] WARNING: __VEDAA_PROJECT_ID is empty — all queries will return no results');
        }catch(e){console.error('[Preview DB] Health check error:',e);}
      })();
    }catch(err){
      console.error('[Preview] Failed to init Supabase client:', err);
    }
  }

  /* ================================================================
     QUEUING STUB — fallback if Supabase CDN hasn't loaded yet
     Records .from().select().eq()... chains and replays them once
     the real client arrives via postMessage.
     ================================================================ */
  if(!window.__supabase_ready){
    setTimeout(function(){if(!window.__supabase_ready){window.__sb_resolve(null)}},8000);
    (function(){
      function _chain(ops,isSingle){
        var b={};
        'select,insert,update,delete,upsert,eq,neq,gt,gte,lt,lte,like,ilike,is,in,contains,containedBy,order,limit,range,not,or,filter,match,textSearch'.split(',').forEach(function(m){
          b[m]=function(){var a=Array.prototype.slice.call(arguments);ops.push({m:m,a:a});return _chain(ops,isSingle)};
        });
        b.single=function(){ops.push({m:'single',a:[]});return _chain(ops,true)};
        b.maybeSingle=function(){ops.push({m:'maybeSingle',a:[]});return _chain(ops,true)};
        b.then=function(res,rej){
          return window.__sb_promise.then(function(client){
            if(!client) return {data:isSingle?null:[],error:{message:'Database connection unavailable'}};
            try{var r=client;for(var i=0;i<ops.length;i++) r=r[ops[i].m].apply(r,ops[i].a);return r;}
            catch(e){return {data:isSingle?null:[],error:{message:e.message}}}
          }).then(function(result){
            if(result&&result.data===null&&!isSingle){
              result={data:[],error:result.error,count:result.count,status:result.status,statusText:result.statusText};
            }
            if(!isSingle) __enrichResult(result);
            return res?res(result):result;
          },rej);
        };
        return b;
      }
      window.supabase={from:function(t){return _chain([{m:'from',a:[t]}],false)}};
    })();
  }

  /* ================================================================
     AUTH UPGRADE — postMessage handler for authenticated client.
     Even if basic client works, we still want the auth token for RLS.
     ================================================================ */
  window.addEventListener('message',function(e){
    if(e.data&&e.data.type==='SUPABASE_INIT'){
      try{
        if(typeof supabase==='undefined'||!supabase.createClient){
          console.error('[Preview] Supabase SDK not loaded');
          return;
        }
        var opts={};
        if(e.data.token){
          opts.global={headers:{Authorization:'Bearer '+e.data.token}};
        }
        var _client=supabase.createClient(e.data.url||__sbUrl,e.data.anonKey||__sbKey,opts);
        window.supabase=__wrapSB(_client);
        if(e.data.tenantId) window.__VEDAA_TENANT_ID=e.data.tenantId;
        if(e.data.projectId) window.__VEDAA_PROJECT_ID=e.data.projectId;
        if(e.data.projectId) window.__VEDAA_APP_INSTANCE_ID=e.data.projectId;
        window.__supabase_ready=true;
        window.__sb_resolve(_client);
        window.dispatchEvent(new Event('supabase:ready'));
        console.log('[Preview] Supabase upgraded (authenticated):', e.data.url||__sbUrl);
      }catch(err){
        console.error('[Preview] Failed to upgrade Supabase:', err);
      }
    }
  });

  /* Request auth token from parent (even if basic client already works) */
  try{
    window.parent.postMessage({type:'REQUEST_SUPABASE_CREDENTIALS'},'*');
  }catch(e){console.warn('[Preview] Could not request Supabase credentials');}

  /* --- helpers --- */
  function b64d(b){
    var s=atob(b),a=new Uint8Array(s.length);
    for(var i=0;i<s.length;i++) a[i]=s.charCodeAt(i);
    return new TextDecoder().decode(a);
  }
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  function showErr(msg,stack){
    document.getElementById('root').innerHTML=
      '<div style="padding:24px;font-family:ui-monospace,monospace;font-size:13px;color:#f38ba8;background:#1e1e2e;min-height:100vh">'+
      '<div style="max-width:640px;margin:40px auto">'+
      '<h2 style="color:#cdd6f4;font-size:16px;margin:0 0 16px">Preview Error</h2>'+
      '<div style="background:#181825;padding:16px;border-radius:8px;border:1px solid #313244;white-space:pre-wrap;word-break:break-word;line-height:1.6">'+
      esc(msg)+(stack?'\\n\\n<span style="color:#6c7086">'+esc(stack)+'</span>':'')+
      '</div></div></div>';
  }

  /* --- component-file registry & require shim --- */
  var __reg;
  try{__reg=${registry};}catch(e){__reg={};console.error('[Preview] Registry parse error:',e.message);showErr('Failed to load component registry: '+e.message);}
  var __cache={};

  function __req(mod){
    if(mod==='react') return React;
    if(mod==='react-dom'||mod==='react-dom/client') return ReactDOM;
    /* Intercept any Supabase-related imports and return window.supabase.
       Generated code may do: import { supabaseClient } from '@/lib/supabase'
       In the preview sandbox, window.supabase IS the client. */
    if(mod.indexOf('supabase')!==-1&&mod!=='@supabase/supabase-js'){
      var _sb=window.supabase||{};
      return {__esModule:true,default:_sb,supabase:_sb,supabaseClient:_sb,createClient:function(){return _sb}};
    }
    if(__cache[mod]) return __cache[mod];

    /* resolve from registry */
    var enc=__reg[mod];
    if(!enc){
      var tries=[mod];
      if(mod.startsWith('@/'))  tries.push('src/'+mod.slice(2));
      if(mod.startsWith('./'))  tries.push('src/'+mod.slice(2),'src/app/'+mod.slice(2));
      if(mod.startsWith('../')) tries.push('src/'+mod.replace(/^\\.\\.\\/*/,''));
      for(var t=0;t<tries.length&&!enc;t++){
        enc=__reg[tries[t]];
        if(!enc){var exts=['.tsx','.jsx','.ts','.js'];for(var e=0;e<exts.length&&!enc;e++) enc=__reg[tries[t]+exts[e]];}
      }
    }
    if(enc){
      var code=b64d(enc), mm={exports:{}};
      try{
        var tr=Babel.transform(code,{presets:['react','typescript',['env',{modules:'commonjs'}]],filename:mod+'.tsx'}).code;
        (new Function('module','exports','require','React','ReactDOM',tr))(mm,mm.exports,__req,React,ReactDOM);
        __cache[mod]=mm.exports;
        return mm.exports;
      }catch(err){console.error('[Preview] Failed to load '+mod+':',err.message);return {}}
    }

    /* unknown module — Proxy returns stubs that work as BOTH components AND data.
       This prevents "Cannot read properties of undefined (reading 'filter')" when
       page.tsx imports data from a truncated/missing data.ts or types.ts file. */
    console.warn('[Preview] Module not available: '+mod);
    try{
      function _mkStub(isDef){
        var fn=isDef
          ? function(){return React.createElement('div')}
          : function(props){
              return React.createElement('span',{
                style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:(props&&props.size)||20,height:(props&&props.size)||20,opacity:0.35},
                className:(props&&props.className)||''
              },'\\u25A1');
            };
        /* Array-like methods so data imports degrade to empty arrays instead of crashing */
        fn.filter=function(){return []};fn.map=function(){return []};fn.find=function(){return undefined};
        fn.forEach=function(){};fn.reduce=function(_,i){return i};fn.some=function(){return false};
        fn.every=function(){return true};fn.includes=function(){return false};fn.flat=function(){return []};
        fn.flatMap=function(){return []};fn.slice=function(){return []};fn.sort=function(){return []};
        fn.concat=function(){return []};fn.length=0;fn.join=function(){return ''};
        fn.indexOf=function(){return -1};fn.splice=function(){return []};fn.push=function(){};
        fn.pop=function(){};fn.shift=function(){};fn.unshift=function(){};
        try{fn[Symbol.iterator]=function(){return{next:function(){return{done:true}}}};}catch(x){}
        return fn;
      }
      return new Proxy({},{
        get:function(_,p){
          if(p==='__esModule') return true;
          if(p==='default') return _mkStub(true);
          if(typeof p==='symbol') return undefined;
          return _mkStub(false);
        }
      });
    }catch(e){return {}}
  }

  /* --- main --- */
  var enc="${mainB64}";
  if(!enc){
    document.getElementById('root').innerHTML=
      '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:#64748b;font-family:system-ui">'+
      '<p style="font-size:14px">Send a prompt to generate your app preview</p></div>';
    return;
  }

  var code;
  try{ code=b64d(enc); }catch(e){ showErr('Failed to decode: '+e.message); return; }

  if(typeof Babel==='undefined'){ showErr('Babel failed to load — check your internet connection.'); return; }
  if(typeof React==='undefined'||typeof ReactDOM==='undefined'){ showErr('React failed to load — check your internet connection.'); return; }
  if(typeof supabase==='undefined'){ console.warn('[Preview] Supabase SDK not loaded (continuing without persistence)'); }

  function renderApp(){
    try{
      var transpiled=Babel.transform(code,{
        presets:['react','typescript',['env',{modules:'commonjs'}]],
        filename:'page.tsx'
      }).code;

      var mod={exports:{}};
      (new Function('module','exports','require','React','ReactDOM',transpiled))(mod,mod.exports,__req,React,ReactDOM);

      var App=mod.exports['default']||mod.exports;

      if(typeof App!=='function'){
        showErr('No valid React component found.\\n\\nThe default export must be a function component.\\nExample: export default function Home() { return <div>Hello</div>; }');
        return;
      }

      /* ---- Class-based Error Boundary ---- */
      function EB(p){React.Component.call(this,p);this.state={error:null};}
      EB.prototype=Object.create(React.Component.prototype);
      EB.prototype.constructor=EB;
      EB.getDerivedStateFromError=function(e){return{error:e};};
      EB.prototype.render=function(){
        if(this.state.error){
          var e=this.state.error;
          return React.createElement('div',{style:{padding:'24px',fontFamily:'ui-monospace,monospace',fontSize:'13px',color:'#f38ba8',background:'#1e1e2e',minHeight:'100vh'}},
            React.createElement('div',{style:{maxWidth:'640px',margin:'40px auto'}},
              React.createElement('h2',{style:{color:'#cdd6f4',fontSize:'16px',margin:'0 0 16px'}},'Render Error'),
              React.createElement('pre',{style:{background:'#181825',padding:'16px',borderRadius:'8px',border:'1px solid #313244',whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:'1.6'}},
                String(e.message||e)+(e.stack?'\\n\\n'+e.stack:''))));
        }
        return this.props.children;
      };

      /* ---- Loading Skeleton (React component) ---- */
      function Skeleton(){
        var s={borderRadius:'8px',animation:'_skelpulse 1.5s ease-in-out infinite'};
        return React.createElement('div',{style:{padding:'32px',maxWidth:'800px',margin:'0 auto'}},
          React.createElement('div',{style:Object.assign({},{height:'32px',width:'60%',background:'#e2e8f0',marginBottom:'16px'},s)}),
          React.createElement('div',{style:Object.assign({},{height:'16px',width:'90%',background:'#e2e8f0',marginBottom:'12px'},s)}),
          React.createElement('div',{style:Object.assign({},{height:'16px',width:'75%',background:'#e2e8f0',marginBottom:'24px'},s)}),
          React.createElement('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'16px'}},
            React.createElement('div',{style:Object.assign({},{height:'120px',background:'#e2e8f0',borderRadius:'12px'},s)}),
            React.createElement('div',{style:Object.assign({},{height:'120px',background:'#e2e8f0',borderRadius:'12px',animationDelay:'0.2s'},s)}),
            React.createElement('div',{style:Object.assign({},{height:'120px',background:'#e2e8f0',borderRadius:'12px',animationDelay:'0.4s'},s)})));
      }

      /* ---- SafeApp: renders App + skeleton fallback when App returns null ---- */
      function SafeApp(){
        var _v=React.useState(true),showSkel=_v[0],setShowSkel=_v[1];
        var _d=React.useState(null),diagErr=_d[0],setDiagErr=_d[1];
        var appRef=React.useRef(null);

        React.useEffect(function(){
          /* Check if App rendered real DOM content */
          function hasContent(){
            var el=appRef.current;
            if(!el) return false;
            for(var i=0;i<el.childNodes.length;i++){
              var n=el.childNodes[i];
              if(n.nodeType===1) return true;
              if(n.nodeType===3&&n.textContent&&n.textContent.trim()) return true;
            }
            return false;
          }

          /* Check at staggered intervals */
          var delays=[200,600,1200,2500,4000];
          var timers=delays.map(function(ms,idx){
            return setTimeout(function(){
              if(hasContent()){
                setShowSkel(false);
              } else if(idx===delays.length-1){
                setShowSkel(false);
                var d=['Errors captured: '+window.__errs.length];
                if(window.__errs.length>0) d.push('First error: '+window.__errs[0].message);
                setDiagErr('The component rendered nothing after 4 seconds.\\n\\nThis usually means the component has a conditional return like "if (!data) return null" that never resolves.\\n\\n'+d.join('\\n'));
                try{window.parent.postMessage({type:'PREVIEW_ERROR',payload:{message:'Component returned null for 4s'}},'*')}catch(x){}
              }
            },ms);
          });

          /* MutationObserver for instant detection when App content appears */
          var obs;
          try{
            obs=new MutationObserver(function(){
              if(hasContent()){ setShowSkel(false); obs.disconnect(); }
            });
            if(appRef.current) obs.observe(appRef.current,{childList:true,subtree:true});
          }catch(e){}

          return function(){
            timers.forEach(clearTimeout);
            if(obs) try{obs.disconnect();}catch(e){}
          };
        },[]);

        /* Show diagnostic error screen */
        if(diagErr){
          return React.createElement('div',{style:{padding:'24px',fontFamily:'ui-monospace,monospace',fontSize:'13px',color:'#f38ba8',background:'#1e1e2e',minHeight:'100vh'}},
            React.createElement('div',{style:{maxWidth:'640px',margin:'40px auto'}},
              React.createElement('h2',{style:{color:'#cdd6f4',fontSize:'16px',margin:'0 0 16px'}},'Preview Error'),
              React.createElement('div',{style:{background:'#181825',padding:'16px',borderRadius:'8px',border:'1px solid #313244',whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:'1.6'}},diagErr)));
        }

        var appEl;
        try{appEl=React.createElement(App);}catch(e){appEl=null;}

        /* Render App content in a ref'd div (for null detection) + skeleton below */
        return React.createElement(React.Fragment,null,
          React.createElement('div',{ref:appRef},appEl),
          showSkel?React.createElement(Skeleton):null);
      }

      /* Inject skeleton keyframes into document head */
      var sty=document.createElement('style');
      sty.textContent='@keyframes _skelpulse{0%,100%{opacity:1}50%{opacity:0.4}}';
      document.head.appendChild(sty);

      var root=ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(EB,null,React.createElement(SafeApp)));
    }catch(err){
      showErr(err.message,err.stack);
      try{window.parent.postMessage({type:'PREVIEW_ERROR',payload:{message:err.message}},'*')}catch(x){}
    }
  }

  /* Render immediately — do NOT wait for Supabase (it initializes in background) */
  renderApp();
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Deployment HTML — variant for Netlify publish
// ---------------------------------------------------------------------------

/**
 * Build a self-contained HTML document for Netlify deployment.
 *
 * Same rendering approach as `buildPreviewDocument` but with:
 * - Supabase credentials hardcoded (not postMessage)
 * - Production React builds (minified)
 * - SEO meta tags for social sharing
 */
export function buildDeployDocument(
  files: FileNode[],
  supabaseUrl: string,
  supabaseAnonKey: string,
  appTitle: string = "App",
  tenantId: string = "",
  projectId: string = "",
): string {
  const allFiles = flattenFiles(files);
  const css = collectCSS(allFiles);
  const mainCode = findMainFile(allFiles);

  const cleanCSS = css
    .replace(/@tailwind\s+\w+;/g, "")
    .replace(/@import\s+[^;]+;/g, "")
    .trim();

  const mainB64 = mainCode ? toBase64(mainCode) : "";

  // Build component registry (same as preview)
  const entries: string[] = [];
  for (const f of allFiles) {
    if (
      !f.content ||
      f.path.includes("layout.") ||
      f.path.includes("page.") ||
      f.path.endsWith(".css") ||
      f.path.endsWith(".json")
    )
      continue;
    if (
      !(
        f.name.endsWith(".tsx") ||
        f.name.endsWith(".jsx") ||
        f.name.endsWith(".ts") ||
        f.name.endsWith(".js")
      )
    )
      continue;

    const b64 = toBase64(f.content);
    const noExt = f.path.replace(/\.(tsx|jsx|ts|js)$/, "");
    const keys = [f.path, noExt];
    if (f.path.startsWith("src/")) {
      keys.push("@/" + f.path.slice(4), "@/" + noExt.slice(4));
      keys.push("./" + f.path.slice(4), "./" + noExt.slice(4));
    }
    for (const k of keys)
      entries.push(`${JSON.stringify(k)}:${JSON.stringify(b64)}`);
  }

  const registry = `{${entries.join(",")}}`;

  const safeSupabaseUrl = supabaseUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeAnonKey = supabaseAnonKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeTitle = appTitle.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${safeTitle} \u2014 Built with Vedaa.io</title>
<meta name="description" content="${safeTitle} \u2014 Built and deployed with Vedaa.io, the autonomous agentic development platform."/>
<meta property="og:title" content="${safeTitle}"/>
<meta property="og:description" content="Built and deployed with Vedaa.io"/>

<script>
window.__errs=[];
window.onerror=function(m,s,l,c,e){window.__errs.push({message:String(m),line:l,stack:e?e.stack:''})};
window.onunhandledrejection=function(e){window.__errs.push({message:e.reason?(e.reason.message||String(e.reason)):'Unhandled rejection'})};
<\/script>

<script crossorigin src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"><\/script>
<script crossorigin src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"><\/script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"><\/script>
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"><\/script>

<style>
html,body,#root{height:100%;width:100%;margin:0;padding:0;overflow-x:hidden}
*,*::before,*::after{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
#root{display:flex;flex-direction:column;min-height:100%}
${cleanCSS}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function(){
  /* --- Initialize Supabase directly --- */
  window.__supabase_ready=false;
  window.supabase=null;
  window.__VEDAA_TENANT_ID="${tenantId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";
  window.__VEDAA_PROJECT_ID="${projectId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";
  window.__VEDAA_APP_INSTANCE_ID="${(projectId || "deployed").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";
  /* --- Supabase response normalizer (same as preview) ---
     Wraps .from() chains so that {data:null} → {data:[]} for list queries.
     Also enriches response with array methods so setCases(result) still works. */
  var __arrayMethods='map,filter,find,findIndex,forEach,some,every,reduce,reduceRight,includes,indexOf,lastIndexOf,flat,flatMap,slice,sort,concat,join,splice,push,pop,shift,unshift,reverse,fill,copyWithin,entries,keys,values,at,toString'.split(',');
  function __enrichResult(result){
    if(!result||typeof result!=='object'||!Array.isArray(result.data)) return result;
    var arr=result.data;
    __arrayMethods.forEach(function(m){
      if(typeof arr[m]==='function'&&!(m in result)){
        result[m]=function(){return arr[m].apply(arr,arguments)};
      }
    });
    if(!('length' in result)){
      Object.defineProperty(result,'length',{get:function(){return arr.length},configurable:true,enumerable:false});
    }
    try{if(typeof Symbol!=='undefined'&&Symbol.iterator&&!(Symbol.iterator in result)){result[Symbol.iterator]=function(){return arr[Symbol.iterator]()};}}catch(x){}
    return result;
  }
  function __wrapSB(client){
    if(!client||!client.from) return client;
    var _origFrom=client.from.bind(client);
    client.from=function(table){
      return __wrapChain(_origFrom(table),false);
    };
    return client;
  }
  function __wrapChain(builder,isSingle){
    if(!builder||typeof builder!=='object') return builder;
    return new Proxy(builder,{
      get:function(target,prop){
        if(prop==='then'){
          var origThen=target.then;
          if(typeof origThen!=='function') return origThen;
          return function(onRes,onRej){
            return origThen.call(target,function(result){
              if(result&&result.data===null&&!isSingle){
                result={data:[],error:result.error,count:result.count,status:result.status,statusText:result.statusText};
              }
              if(!isSingle) __enrichResult(result);
              return onRes?onRes(result):result;
            },onRej);
          };
        }
        var val=target[prop];
        if(typeof val==='function'){
          return function(){
            var next=val.apply(target,arguments);
            var nextSingle=isSingle||(prop==='single')||(prop==='maybeSingle');
            if(next&&typeof next==='object'&&typeof next.then==='function'){
              return __wrapChain(next,nextSingle);
            }
            return next;
          };
        }
        return val;
      }
    });
  }

  try{
    if(typeof supabase!=='undefined'&&supabase.createClient){
      window.supabase=__wrapSB(supabase.createClient("${safeSupabaseUrl}","${safeAnonKey}"));
      window.__supabase_ready=true;
    }
  }catch(err){console.error('Failed to init Supabase:',err)}
  /* Fallback stub if Supabase SDK failed to load — prevents crashes */
  if(!window.__supabase_ready){
    (function(){
      function _c(){var o={};
        'from,select,insert,update,delete,upsert,eq,neq,gt,gte,lt,lte,like,ilike,is,in,contains,containedBy,order,limit,range,single,maybeSingle,not,or,filter,match,textSearch'.split(',').forEach(function(m){
          o[m]=function(){return _c()};
        });
        o.then=function(r){return Promise.resolve({data:[],error:{message:'Database connection unavailable'}}).then(r)};
        return o;
      }
      window.supabase={from:function(){return _c()}};
    })();
  }

  function b64d(b){
    var s=atob(b),a=new Uint8Array(s.length);
    for(var i=0;i<s.length;i++) a[i]=s.charCodeAt(i);
    return new TextDecoder().decode(a);
  }
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  function showErr(msg,stack){
    document.getElementById('root').innerHTML=
      '<div style="padding:24px;font-family:ui-monospace,monospace;font-size:13px;color:#f38ba8;background:#1e1e2e;min-height:100vh">'+
      '<div style="max-width:640px;margin:40px auto">'+
      '<h2 style="color:#cdd6f4;font-size:16px;margin:0 0 16px">Error</h2>'+
      '<div style="background:#181825;padding:16px;border-radius:8px;border:1px solid #313244;white-space:pre-wrap;word-break:break-word;line-height:1.6">'+
      esc(msg)+(stack?'\\n\\n<span style="color:#6c7086">'+esc(stack)+'</span>':'')+
      '</div></div></div>';
  }

  var __reg=${registry};
  var __cache={};

  function __req(mod){
    if(mod==='react') return React;
    if(mod==='react-dom'||mod==='react-dom/client') return ReactDOM;
    /* Intercept Supabase-related imports → return window.supabase */
    if(mod.indexOf('supabase')!==-1&&mod!=='@supabase/supabase-js'){
      var _sb=window.supabase||{};
      return {__esModule:true,default:_sb,supabase:_sb,supabaseClient:_sb,createClient:function(){return _sb}};
    }
    if(__cache[mod]) return __cache[mod];

    var enc=__reg[mod];
    if(!enc){
      var tries=[mod];
      if(mod.startsWith('@/'))  tries.push('src/'+mod.slice(2));
      if(mod.startsWith('./'))  tries.push('src/'+mod.slice(2),'src/app/'+mod.slice(2));
      if(mod.startsWith('../')) tries.push('src/'+mod.replace(/^\\.\\.\\/*/,''));
      for(var t=0;t<tries.length&&!enc;t++){
        enc=__reg[tries[t]];
        if(!enc){var exts=['.tsx','.jsx','.ts','.js'];for(var e=0;e<exts.length&&!enc;e++) enc=__reg[tries[t]+exts[e]];}
      }
    }
    if(enc){
      var code=b64d(enc), mm={exports:{}};
      try{
        var tr=Babel.transform(code,{presets:['react','typescript',['env',{modules:'commonjs'}]],filename:mod+'.tsx'}).code;
        (new Function('module','exports','require','React','ReactDOM',tr))(mm,mm.exports,__req,React,ReactDOM);
        __cache[mod]=mm.exports;
        return mm.exports;
      }catch(err){console.error('Failed to load '+mod+':',err.message);return {}}
    }

    console.warn('Module not available: '+mod);
    try{
      function _mkStub(isDef){
        var fn=isDef
          ? function(){return React.createElement('div')}
          : function(props){
              return React.createElement('span',{
                style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:(props&&props.size)||20,height:(props&&props.size)||20,opacity:0.35},
                className:(props&&props.className)||''
              },'\\u25A1');
            };
        fn.filter=function(){return []};fn.map=function(){return []};fn.find=function(){return undefined};
        fn.forEach=function(){};fn.reduce=function(_,i){return i};fn.some=function(){return false};
        fn.every=function(){return true};fn.includes=function(){return false};fn.flat=function(){return []};
        fn.flatMap=function(){return []};fn.slice=function(){return []};fn.sort=function(){return []};
        fn.concat=function(){return []};fn.length=0;fn.join=function(){return ''};
        fn.indexOf=function(){return -1};fn.splice=function(){return []};fn.push=function(){};
        fn.pop=function(){};fn.shift=function(){};fn.unshift=function(){};
        try{fn[Symbol.iterator]=function(){return{next:function(){return{done:true}}}};}catch(x){}
        return fn;
      }
      return new Proxy({},{
        get:function(_,p){
          if(p==='__esModule') return true;
          if(p==='default') return _mkStub(true);
          if(typeof p==='symbol') return undefined;
          return _mkStub(false);
        }
      });
    }catch(e){return {}}
  }

  var enc="${mainB64}";
  if(!enc){
    document.getElementById('root').innerHTML=
      '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:#64748b;font-family:system-ui">'+
      '<p style="font-size:14px">This app is being set up...</p></div>';
    return;
  }

  var code;
  try{ code=b64d(enc); }catch(e){ showErr('Failed to decode: '+e.message); return; }
  if(typeof Babel==='undefined'){ showErr('Babel failed to load.'); return; }
  if(typeof React==='undefined'||typeof ReactDOM==='undefined'){ showErr('React failed to load.'); return; }

  try{
    var transpiled=Babel.transform(code,{
      presets:['react','typescript',['env',{modules:'commonjs'}]],
      filename:'page.tsx'
    }).code;

    var mod={exports:{}};
    (new Function('module','exports','require','React','ReactDOM',transpiled))(mod,mod.exports,__req,React,ReactDOM);

    var App=mod.exports['default']||mod.exports;
    if(typeof App!=='function'){
      showErr('No valid React component found.\\nThe default export must be a function component.');
      return;
    }

    /* Error boundary for deployed apps */
    function EB(p){React.Component.call(this,p);this.state={error:null};}
    EB.prototype=Object.create(React.Component.prototype);
    EB.prototype.constructor=EB;
    EB.getDerivedStateFromError=function(e){return{error:e};};
    EB.prototype.render=function(){
      if(this.state.error){
        var e=this.state.error;
        return React.createElement('div',{style:{padding:'24px',fontFamily:'system-ui',fontSize:'14px',color:'#dc2626',minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}},
          React.createElement('div',{style:{maxWidth:'480px',textAlign:'center'}},
            React.createElement('h2',{style:{fontSize:'18px',fontWeight:'600',color:'#111',marginBottom:'8px'}},'Something went wrong'),
            React.createElement('p',{style:{color:'#6b7280'}},String(e.message||e))));
      }
      return this.props.children;
    };

    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(EB,null,React.createElement(App)));
  }catch(err){
    showErr(err.message,err.stack);
  }
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export function PreviewPane({ url, files, onError, isGenerating, tenantId, projectId, userToken }: PreviewPaneProps) {
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);

  // Compute a content hash from file tree to detect changes
  const contentHash = useMemo(() => {
    if (!files || files.length === 0) return "";
    const flat = flattenFiles(files);
    let hash = 0;
    for (const f of flat) {
      const s = f.path + (f.content || "");
      for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
      }
    }
    return String(hash);
  }, [files]);

  const srcdoc = useMemo(() => {
    if (files && files.length > 0) {
      return buildPreviewDocument(
        files,
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        tenantId,
        projectId,
        userToken,
      );
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, refreshKey, contentHash, userToken]);

  // Listen for error messages from the preview iframe
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "PREVIEW_ERROR") {
        const errorMsg = e.data.payload?.message || "Unknown error";
        setPreviewErrors((prev) => [...prev.slice(-19), errorMsg]);
        onError?.(errorMsg);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onError]);

  // Handle Supabase credential requests from preview iframe
  useEffect(() => {
    async function handleCredentialRequest(e: MessageEvent) {
      // Security: only respond to messages from same origin or blob/srcdoc iframes
      if (e.origin !== window.location.origin && e.origin !== "null" && e.origin !== "") {
        return;
      }

      if (e.data?.type === "REQUEST_SUPABASE_CREDENTIALS") {
        try {
          const response = await fetch("/api/preview-credentials");
          if (!response.ok) {
            console.error("[PreviewPane] Failed to fetch credentials:", response.statusText);
            return;
          }

          const credentials = await response.json();

          // Build payload with auth context for CRUD operations
          const payload = {
            type: "SUPABASE_INIT",
            url: credentials.url,
            anonKey: credentials.anonKey,
            token: userToken || "",
            tenantId: tenantId || "",
            projectId: projectId || "",
          };

          // Send credentials only to our own iframes, using specific origin
          const iframes = document.getElementsByTagName("iframe");
          const targetOrigin = window.location.origin;
          for (let i = 0; i < iframes.length; i++) {
            try {
              iframes[i].contentWindow?.postMessage(payload, targetOrigin);
            } catch {
              // srcdoc iframes have null origin, retry with *
              try {
                iframes[i].contentWindow?.postMessage(payload, "*");
              } catch {
                // silently ignore
              }
            }
          }
        } catch (error) {
          console.error("[PreviewPane] Error handling credential request:", error);
        }
      }
    }

    window.addEventListener("message", handleCredentialRequest);
    return () => window.removeEventListener("message", handleCredentialRequest);
  }, [userToken, tenantId, projectId]);

  // Clear errors on new content / refresh
  useEffect(() => {
    setPreviewErrors([]);
  }, [srcdoc, refreshKey]);

  const hasUrl = !!url;
  const hasLivePreview = !!srcdoc;
  const hasAnyPreview = hasUrl || hasLivePreview;

  if (!hasAnyPreview) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-surface-0">
        <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-surface-3 flex items-center justify-center mb-5">
          <Globe className="w-8 h-8 text-slate-600" />
        </div>
        <h3 className="text-white font-medium mb-2">No Preview Available</h3>
        <p className="text-slate-500 text-sm text-center max-w-xs leading-relaxed">
          Send a prompt to the AI agent to generate your app. Once built, a live
          preview will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* Toolbar */}
      <div className="h-10 border-b border-surface-3 flex items-center justify-between px-3 shrink-0">
        <div className="flex items-center gap-1">
          {(
            Object.entries(VIEWPORTS) as [
              ViewportSize,
              (typeof VIEWPORTS)[ViewportSize],
            ][]
          ).map(([key, { icon: Icon, label }]) => (
            <button
              key={key}
              onClick={() => setViewport(key)}
              title={label}
              className={cn(
                "p-1.5 rounded-md transition-all",
                viewport === key
                  ? "bg-surface-3 text-white"
                  : "text-slate-600 hover:text-slate-300 hover:bg-surface-2"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ))}

          {/* Live preview badge */}
          {!hasUrl && hasLivePreview && (
            <div className="flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <Play className="w-2.5 h-2.5 text-emerald-400 fill-emerald-400" />
              <span className="text-2xs text-emerald-400 font-medium">
                Live
              </span>
            </div>
          )}

          {/* Error indicator */}
          {previewErrors.length > 0 && (
            <div
              className="flex items-center gap-1 ml-1 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 cursor-help"
              title={previewErrors[previewErrors.length - 1]}
            >
              <AlertTriangle className="w-2.5 h-2.5 text-red-400" />
              <span className="text-2xs text-red-400 font-medium">
                {previewErrors.length} error
                {previewErrors.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>

        {/* URL bar */}
        <div className="flex-1 mx-3 px-3 py-1 rounded-md bg-surface-2 border border-surface-3 text-xs text-slate-500 truncate font-mono">
          {hasUrl ? url : "live-preview://localhost"}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="p-1.5 rounded-md text-slate-600 hover:text-white hover:bg-surface-2 transition-all"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {hasUrl && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md text-slate-600 hover:text-white hover:bg-surface-2 transition-all"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* iframe */}
      <div className="flex-1 relative flex items-start justify-center p-4 bg-surface-2/30 overflow-auto">
        <div
          className="bg-white rounded-lg shadow-2xl overflow-hidden transition-all duration-300 h-full"
          style={{ width: VIEWPORTS[viewport].width, maxWidth: "100%" }}
        >
          {hasLivePreview ? (
            <iframe
              key={`live-${refreshKey}-${contentHash}`}
              srcDoc={srcdoc!}
              className="w-full h-full border-0"
              title="Live Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : hasUrl ? (
            <iframe
              key={refreshKey}
              src={url}
              className="w-full h-full border-0"
              title="App Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : null}
        </div>

        {/* Generating overlay — dims old preview while new code is being generated */}
        {isGenerating && (
          <div className="absolute inset-0 bg-surface-0/80 backdrop-blur-sm flex flex-col items-center justify-center z-10 animate-fade-in">
            <div className="w-12 h-12 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mb-4">
              <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
            </div>
            <p className="text-sm text-slate-400 font-medium">Generating new preview...</p>
            <div className="mt-3 flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot" />
              <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.2s]" />
              <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.4s]" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
