/**
 * Serve published apps directly as self-contained HTML.
 *
 * This route is called by the middleware when a subdomain request comes in
 * (e.g., my-app.vedaa.io). It fetches the project from Supabase by slug,
 * builds the self-contained HTML document, and returns it.
 *
 * This approach works because *.vedaa.io wildcard DNS points to the main
 * Netlify site, and the middleware rewrites subdomain requests here.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// File-tree helpers (same as PreviewPane but server-side)
// ---------------------------------------------------------------------------

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  language?: string;
  content?: string;
  children?: FileNode[];
}

function codeMapToTree(codeFiles: Record<string, string>): FileNode[] {
  const tree: FileNode[] = [];
  for (const [path, content] of Object.entries(codeFiles)) {
    const parts = path.split("/");
    addToTree(tree, parts, 0, content);
  }
  return tree;
}

function addToTree(tree: FileNode[], parts: string[], index: number, content: string): void {
  if (index >= parts.length) return;
  const part = parts[index];
  const isFile = index === parts.length - 1;
  const fullPath = parts.slice(0, index + 1).join("/");
  let node = tree.find((n) => n.name === part);
  if (!node) {
    const ext = part.split(".").pop() ?? "";
    const langMap: Record<string, string> = {
      tsx: "typescriptreact", jsx: "javascriptreact",
      ts: "typescript", js: "javascript",
      css: "css", json: "json", html: "html",
    };
    node = {
      name: part, path: fullPath,
      type: isFile ? "file" : "directory",
      ...(isFile && { language: langMap[ext] ?? "plaintext", content }),
      ...(isFile ? {} : { children: [] }),
    };
    tree.push(node);
  }
  if (!isFile && node.children) {
    addToTree(node.children, parts, index + 1, content);
  } else if (isFile) {
    node.content = content;
  }
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const n of nodes) {
    if (n.type === "file") result.push(n);
    if (n.children) result.push(...flattenFiles(n.children));
  }
  return result;
}

function collectCSS(files: FileNode[]): string {
  return files.filter((f) => f.path.endsWith(".css") && f.content).map((f) => f.content!).join("\n");
}

function findMainFile(files: FileNode[]): string {
  const isReal = (f: FileNode) => f.content && !f.content.includes("Your generated code will appear here");
  const main =
    files.find((f) => (f.path.includes("page.tsx") || f.path.includes("page.jsx")) && isReal(f)) ??
    files.find((f) => (f.path.includes("App.tsx") || f.path.includes("App.jsx")) && isReal(f)) ??
    files.find((f) => (f.path.includes("index.tsx") || f.path.includes("index.jsx")) && isReal(f)) ??
    files.find((f) => (f.language === "typescriptreact" || f.language === "javascriptreact") && isReal(f)) ??
    files.find((f) => f.path.includes("page.tsx") || f.path.includes("page.jsx")) ??
    files.find((f) => (f.language === "typescriptreact" || f.language === "javascriptreact") && f.content);
  return main?.content ?? "";
}

function toBase64(str: string): string {
  const bytes = Buffer.from(str, "utf-8");
  return bytes.toString("base64");
}

// ---------------------------------------------------------------------------
// Build self-contained HTML (server-side version of buildDeployDocument)
// ---------------------------------------------------------------------------

function buildAppHTML(files: FileNode[], appTitle: string, projectId?: string, tenantId?: string): string {
  const allFiles = flattenFiles(files);
  const css = collectCSS(allFiles);
  const mainCode = findMainFile(allFiles);
  const cleanCSS = css.replace(/@tailwind\s+\w+;/g, "").replace(/@import\s+[^;]+;/g, "").trim();
  const mainB64 = mainCode ? toBase64(mainCode) : "";

  // Build component registry
  const entries: string[] = [];
  for (const f of allFiles) {
    if (!f.content || f.path.includes("layout.") || f.path.includes("page.") || f.path.endsWith(".css") || f.path.endsWith(".json")) continue;
    if (!(f.name.endsWith(".tsx") || f.name.endsWith(".jsx") || f.name.endsWith(".ts") || f.name.endsWith(".js"))) continue;
    const b64 = toBase64(f.content);
    const noExt = f.path.replace(/\.(tsx|jsx|ts|js)$/, "");
    const keys = [f.path, noExt];
    if (f.path.startsWith("src/")) {
      keys.push("@/" + f.path.slice(4), "@/" + noExt.slice(4));
      keys.push("./" + f.path.slice(4), "./" + noExt.slice(4));
    }
    for (const k of keys) entries.push(`${JSON.stringify(k)}:${JSON.stringify(b64)}`);
  }
  const registry = `{${entries.join(",")}}`;

  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeTitle = appTitle.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${safeTitle} — Built with Vedaa.io</title>
<meta name="description" content="${safeTitle} — Built and deployed with Vedaa.io"/>
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
  window.__supabase_ready=false;
  window.supabase=null;
  window.__VEDAA_TENANT_ID="${(tenantId || "").replace(/"/g, '\\"')}";
  window.__VEDAA_PROJECT_ID="${(projectId || "").replace(/"/g, '\\"')}";
  window.__VEDAA_APP_INSTANCE_ID="${(projectId || "deployed").replace(/"/g, '\\"')}";
  /* --- Supabase response normalizer ---
     Wraps .from() chains so that {data:null} → {data:[]} for list queries.
     This prevents "X.filter is not a function" when Supabase returns null data. */
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
      window.supabase=__wrapSB(supabase.createClient("${supabaseUrl}","${supabaseAnonKey}"));
      window.__supabase_ready=true;
    }
  }catch(err){console.error('Failed to init Supabase:',err)}

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
    if(__cache[mod]) return __cache[mod];
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
      }catch(err){console.error('Failed to load '+mod+':',err.message);return {}}
    }
    console.warn('Module not available: '+mod);
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
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  }catch(err){
    showErr(err.message,err.stack);
  }
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return new NextResponse("Missing slug parameter", { status: 400 });
  }

  // Create a Supabase client (no auth needed - public access)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new NextResponse("Server configuration error", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  // Fetch project by slug
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, slug, code_files, deployment_status, tenant_id")
    .eq("slug", slug)
    .single();

  if (error || !project) {
    // Return a nice 404 page
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><title>App Not Found</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a,#020617);font-family:system-ui">
<div style="text-align:center">
<h1 style="color:#fff;font-size:2.5rem;margin:0 0 8px">App Not Found</h1>
<p style="color:#94a3b8;margin:0 0 24px">The app "${slug.replace(/</g, "&lt;")}" doesn't exist or hasn't been published yet.</p>
<a href="https://vedaa.io" style="color:#3b82f6;text-decoration:none;font-size:14px">Back to Vedaa.io</a>
</div></body></html>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const codeFiles = (project.code_files ?? {}) as Record<string, string>;
  if (Object.keys(codeFiles).length === 0) {
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><title>${project.name} - Not Ready</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a,#020617);font-family:system-ui">
<div style="text-align:center">
<h1 style="color:#fff;font-size:2rem;margin:0 0 8px">${project.name}</h1>
<p style="color:#94a3b8;margin:0">This app hasn't been built yet. Check back soon!</p>
</div></body></html>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // Build self-contained HTML
  const fileTree = codeMapToTree(codeFiles);
  const html = buildAppHTML(fileTree, project.name || "App", project.id, project.tenant_id);

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
