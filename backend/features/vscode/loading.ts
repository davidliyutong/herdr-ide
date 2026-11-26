// The page a VS Code pane shows while code-server is prepared on its
// machine: it polls /api/m/<machine>/code/status, shows the phase (whose
// codes it translates itself) and the error with a retry, and reloads once
// code-server is ready. It takes the language and the light or dark theme
// from the page that frames it (same origin).

/** A string as a JavaScript literal inside a script element. */
const js = (s: string) =>
  JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export const LOADING_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'";

export function loadingPage(machine: { id: string; label: string }): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>code-server</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#c9d1d9;font:13px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}
.box{max-width:460px;text-align:center}.bar{height:4px;background:#333;border-radius:2px;margin:14px 0;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#7aa2f7;transition:width .3s}
.err{color:#f7768e;white-space:pre-wrap;text-align:left;font-size:12px}button{margin-top:10px;background:#2b3245;color:#c9d1d9;border:1px solid #3b4a6b;border-radius:4px;padding:4px 12px;cursor:pointer}
.light{background:#fff;color:#24292f}.light .bar{background:#d0d7de}.light .bar i{background:#2f6fde}.light .err{color:#cf222e}.light button{background:#f6f8fa;color:#24292f;border-color:#d0d7de}</style>
<div class="box"><div id="title"></div><div class="bar"><i id="bar"></i></div><div id="phase">…</div><div id="err" class="err"></div><button id="retry" hidden></button></div>
<script>
const machine=${js(machine.label)}, base=${js(`/api/m/${encodeURIComponent(machine.id)}/code`)};
const T={
 en:{title:'Preparing VS Code on {m}',retry:'Retry',idle:'Waiting…',check:'Checking code-server {d}',download:'Downloading code-server {d}',machine_download:'{m} is downloading code-server {d}',upload:'Uploading and installing code-server {d}',install_bridge:'Installing the bridge extension',install_ext:'Installing extension {d}',start:'Starting code-server {d}',ready:'Ready',error:'Failed'},
 zh:{title:'正在 {m} 上准备 VS Code',retry:'重试',idle:'等待中…',check:'正在检查 code-server {d}',download:'正在下载 code-server {d}',machine_download:'{m} 正在下载 code-server {d}',upload:'正在上传并安装 code-server {d}',install_bridge:'正在安装桥接扩展',install_ext:'正在安装扩展 {d}',start:'正在启动 code-server {d}',ready:'就绪',error:'失败'}};
let host={};try{host=parent.document.documentElement}catch(e){}
const L=T[(host.lang||navigator.language||'en').toLowerCase().startsWith('zh')?'zh':'en'];
if(host.dataset&&host.dataset.theme==='light')document.body.className='light';
const fmt=(s,v)=>s.replace('{m}',machine).replace('{d}',v||'');
document.getElementById('title').textContent=fmt(L.title);
document.getElementById('retry').textContent=L.retry;
async function poll(){
  try{const s=await (await fetch(base+'/status',{cache:'no-store'})).json();
    if(s.ready){location.reload();return}
    document.getElementById('phase').textContent=fmt(L[s.phase]||s.phase,s.detail);
    document.getElementById('bar').style.width=s.total?Math.round(100*s.done/s.total)+'%':'0';
    document.getElementById('err').textContent=s.error||'';
    document.getElementById('retry').hidden=!s.error;
    if(s.error)return;
  }catch(e){}
  setTimeout(poll,800);
}
document.getElementById('retry').onclick=async()=>{await fetch(base+'/start',{method:'POST'});document.getElementById('err').textContent='';poll()};
poll();
</script>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': LOADING_CSP,
    },
  });
}
