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
  const main =
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

function buildPreviewDocument(files: FileNode[]): string {
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
  /* --- Supabase initialization (postMessage from parent) --- */
  window.__supabase_ready=false;
  window.supabase=null;

  window.addEventListener('message',function(e){
    if(e.data&&e.data.type==='SUPABASE_INIT'){
      try{
        if(typeof supabase==='undefined'||!supabase.createClient){
          console.error('[Preview] Supabase SDK not loaded');
          return;
        }
        window.supabase=supabase.createClient(e.data.url,e.data.anonKey);
        window.__supabase_ready=true;
        window.dispatchEvent(new Event('supabase:ready'));
        console.log('[Preview] Supabase initialized:',e.data.url);
      }catch(err){
        console.error('[Preview] Failed to initialize Supabase:',err);
      }
    }
  });

  /* Request credentials from parent */
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
  var __reg=${registry};
  var __cache={};

  function __req(mod){
    if(mod==='react') return React;
    if(mod==='react-dom'||mod==='react-dom/client') return ReactDOM;
    if(__cache[mod]) return __cache[mod];

    /* resolve from registry */
    var enc=__reg[mod];
    if(!enc){
      var tries=[mod];
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

    /* unknown module — Proxy returns placeholder components (icons, UI libs, etc.) */
    console.warn('[Preview] Module not available: '+mod);
    try{
      return new Proxy({},{
        get:function(_,p){
          if(p==='__esModule') return false;
          if(p==='default') return function(){return React.createElement('div')};
          if(typeof p==='symbol') return undefined;
          return function(props){
            return React.createElement('span',{
              style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:(props&&props.size)||20,height:(props&&props.size)||20,opacity:0.35},
              className:(props&&props.className)||''
            },'\\u25A1');
          };
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

  /* --- Show loading state while waiting for database connection --- */
  function showLoading(msg){
    document.getElementById('root').innerHTML=
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;color:#94a3b8;font-family:system-ui;gap:12px">'+
      '<div style="width:40px;height:40px;border:3px solid #334155;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite"></div>'+
      '<p style="font-size:13px">'+msg+'</p>'+
      '<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>';
  }

  /* Wait for Supabase to be ready before rendering */
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

      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    }catch(err){
      showErr(err.message,err.stack);
      try{window.parent.postMessage({type:'PREVIEW_ERROR',payload:{message:err.message}},'*')}catch(x){}
    }
  }

  /* Wait for Supabase ready event (max 3 seconds) */
  if(window.__supabase_ready){
    renderApp();
  }else{
    showLoading('Connecting to database...');
    var timeout=setTimeout(function(){
      console.warn('[Preview] Supabase initialization timeout - continuing anyway');
      renderApp();
    },3000);
    window.addEventListener('supabase:ready',function(){
      clearTimeout(timeout);
      renderApp();
    });
  }
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export function PreviewPane({ url, files }: PreviewPaneProps) {
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);

  const srcdoc = useMemo(() => {
    if (files && files.length > 0) {
      return buildPreviewDocument(files);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, refreshKey]);

  // Listen for error messages from the preview iframe
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "PREVIEW_ERROR") {
        setPreviewErrors((prev) => [
          ...prev.slice(-19),
          e.data.payload?.message || "Unknown error",
        ]);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Handle Supabase credential requests from preview iframe
  useEffect(() => {
    async function handleCredentialRequest(e: MessageEvent) {
      if (e.data?.type === "REQUEST_SUPABASE_CREDENTIALS") {
        try {
          // Fetch credentials from backend
          const { preview } = await import("@/lib/api");
          const token = ""; // TODO: Get auth token from session/context

          // For now, fetch without auth (endpoint should be public or we need to integrate auth)
          const response = await fetch("/api/preview-credentials");
          if (!response.ok) {
            console.error("[PreviewPane] Failed to fetch credentials:", response.statusText);
            return;
          }

          const credentials = await response.json();

          // Send credentials to iframe
          const iframes = document.getElementsByTagName("iframe");
          for (let i = 0; i < iframes.length; i++) {
            try {
              iframes[i].contentWindow?.postMessage(
                {
                  type: "SUPABASE_INIT",
                  url: credentials.url,
                  anonKey: credentials.anonKey,
                },
                "*"
              );
            } catch (err) {
              console.error("[PreviewPane] Failed to send credentials to iframe:", err);
            }
          }
        } catch (error) {
          console.error("[PreviewPane] Error handling credential request:", error);
        }
      }
    }

    window.addEventListener("message", handleCredentialRequest);
    return () => window.removeEventListener("message", handleCredentialRequest);
  }, []);

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
      <div className="flex-1 flex items-start justify-center p-4 bg-surface-2/30 overflow-auto">
        <div
          className="bg-white rounded-lg shadow-2xl overflow-hidden transition-all duration-300 h-full"
          style={{ width: VIEWPORTS[viewport].width, maxWidth: "100%" }}
        >
          {hasUrl ? (
            <iframe
              key={refreshKey}
              src={url}
              className="w-full h-full border-0"
              title="App Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            <iframe
              key={`live-${refreshKey}`}
              srcDoc={srcdoc!}
              className="w-full h-full border-0"
              title="Live Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}
        </div>
      </div>
    </div>
  );
}
