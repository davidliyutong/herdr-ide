package server

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/machines"
)

// codeServerProxy serves /m/{id}/code/... from the machine's code-server,
// reached through the agent (no ports are opened on the machine). It also
// tracks VS Code activity per machine so idle code-servers can be stopped.
type codeServerProxy struct {
	s  *Server
	mu sync.Mutex
	// per-machine reverse proxies; transports must not share pools.
	proxies map[string]*httputil.ReverseProxy
	// open upgraded (WebSocket) connections and last request per machine
	active map[string]int
	last   map[string]time.Time
}

func newCodeServerProxy(s *Server) *codeServerProxy {
	return &codeServerProxy{s: s, proxies: map[string]*httputil.ReverseProxy{}, active: map[string]int{}, last: map[string]time.Time{}}
}

func (p *codeServerProxy) touch(id string, delta int) {
	p.mu.Lock()
	p.active[id] += delta
	p.last[id] = time.Now()
	p.mu.Unlock()
}

// idle returns machines whose running code-server has had no open VS Code
// connection and no request for longer than d.
func (p *codeServerProxy) idle(d time.Duration) []string {
	return p.idleAmong(p.s.cs.Running(), d)
}

func (p *codeServerProxy) idleAmong(running []string, d time.Duration) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, id := range running {
		last, seen := p.last[id]
		if !seen {
			// Started without traffic through us yet (e.g. by a bridge
			// command); start the clock now.
			p.last[id] = time.Now()
			continue
		}
		if p.active[id] == 0 && time.Since(last) > d {
			out = append(out, id)
			delete(p.last, id)
		}
	}
	return out
}

func (p *codeServerProxy) proxy(mc *machines.Machine) *httputil.ReverseProxy {
	p.mu.Lock()
	defer p.mu.Unlock()
	if rp := p.proxies[mc.ID()]; rp != nil {
		return rp
	}
	prefix := "/m/" + mc.ID() + "/code"
	cs := p.s.cs
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = "code-server"
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, prefix)
			pr.Out.URL.RawPath = strings.TrimPrefix(pr.In.URL.RawPath, prefix)
			if pr.Out.URL.Path == "" {
				pr.Out.URL.Path = "/"
			}
			// code-server checks WebSocket Origin against Host.
			pr.Out.Host = pr.In.Host
			pr.Out.Header.Del(ProxySecretHeader)
			pr.SetXForwarded()
		},
		ModifyResponse: func(resp *http.Response) error {
			// Our page frames code-server; nobody else may.
			resp.Header.Set("X-Frame-Options", "SAMEORIGIN")
			return nil
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return cs.Dial(ctx, mc)
			},
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: 2 * time.Minute,
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if !errors.Is(err, context.Canceled) {
				p.s.logger.Printf("code-server proxy %s: %v", mc.Label(), err)
				cs.Invalidate(mc.ID())
			}
			http.Error(w, "code-server unavailable: "+err.Error(), http.StatusBadGateway)
		},
	}
	p.proxies[mc.ID()] = rp
	return rp
}

// portProxyPath reports whether path, below /m/{id}/code, is one of
// code-server's port proxy routes. They would serve whatever listens on a
// port of the machine with our origin, where its scripts could drive every
// pane, so they are refused even if a code-server started without
// --disable-proxy (by an earlier build) is still running. Express matches
// routes case-insensitively.
func portProxyPath(path string) bool {
	path = strings.ToLower(path)
	for _, route := range []string{"/proxy", "/absproxy"} {
		if path == route || strings.HasPrefix(path, route+"/") {
			return true
		}
	}
	return false
}

func (p *codeServerProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if portProxyPath(strings.TrimPrefix(r.URL.Path, "/m/"+r.PathValue("id")+"/code")) {
		p.s.audit.log(r, "denied.port_proxy", map[string]any{"machine": r.PathValue("id"), "path": r.URL.Path})
		http.Error(w, "code-server port proxy disabled", http.StatusForbidden)
		return
	}
	mc := p.s.machine(w, r)
	if mc == nil {
		return
	}
	if !p.s.cs.Ready(mc) {
		go p.s.cs.Ensure(context.Background(), mc)
		if r.Method == http.MethodGet && r.Header.Get("Upgrade") == "" && strings.TrimSuffix(r.URL.Path, "/") == "/m/"+mc.ID()+"/code" {
			p.s.audit.log(r, "code_server.open", map[string]any{"machine": mc.ID(), "folder": r.URL.Query().Get("folder")})
			p.loadingPage(w, mc)
			return
		}
		http.Error(w, "code-server is starting", http.StatusServiceUnavailable)
		return
	}
	// A WebSocket stays inside ServeHTTP for its whole lifetime, which is
	// what keeps the machine's code-server from being reaped as idle.
	upgrade := r.Header.Get("Upgrade") != ""
	if upgrade {
		p.touch(mc.ID(), 1)
		defer p.touch(mc.ID(), -1)
	} else {
		p.touch(mc.ID(), 0)
	}
	p.proxy(mc).ServeHTTP(w, r)
}

// loadingPage is shown in the VS Code panel while code-server is prepared.
// It translates the phase codes reported by /code/status itself, and takes
// the language and light/dark theme from the embedding page (same origin).
func (p *codeServerProxy) loadingPage(w http.ResponseWriter, mc *machines.Machine) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'")
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>code-server</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#c9d1d9;font:13px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}
.box{max-width:460px;text-align:center}.bar{height:4px;background:#333;border-radius:2px;margin:14px 0;overflow:hidden}.bar i{display:block;height:100%%;width:0;background:#7aa2f7;transition:width .3s}
.err{color:#f7768e;white-space:pre-wrap;text-align:left;font-size:12px}button{margin-top:10px;background:#2b3245;color:#c9d1d9;border:1px solid #3b4a6b;border-radius:4px;padding:4px 12px;cursor:pointer}
.light{background:#fff;color:#24292f}.light .bar{background:#d0d7de}.light .bar i{background:#2f6fde}.light .err{color:#cf222e}.light button{background:#f6f8fa;color:#24292f;border-color:#d0d7de}</style>
<div class="box"><div id="title"></div><div class="bar"><i id="bar"></i></div><div id="phase">…</div><div id="err" class="err"></div><button id="retry" hidden></button></div>
<script>
const machine=%q, base=%q;
const T={
 en:{title:'Preparing VS Code on {m}',retry:'Retry',idle:'Waiting…',check:'Checking code-server {d}',download:'Downloading code-server {d}',machine_download:'{m} is downloading code-server {d}',upload:'Uploading and installing code-server {d}',install_bridge:'Installing the bridge extension',install_ext:'Installing extension {d}',start:'Starting code-server {d}',ready:'Ready',error:'Failed'},
 zh:{title:'正在 {m} 上准备 VS Code',retry:'重试',idle:'等待中…',check:'检查 code-server {d}',download:'下载 code-server {d}',machine_download:'{m} 正在下载 code-server {d}',upload:'上传并安装 code-server {d}',install_bridge:'安装桥接扩展',install_ext:'安装扩展 {d}',start:'启动 code-server {d}',ready:'就绪',error:'失败'}};
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
    document.getElementById('bar').style.width=s.total?Math.round(100*s.done/s.total)+'%%':'0';
    document.getElementById('err').textContent=s.error||'';
    document.getElementById('retry').hidden=!s.error;
    if(s.error)return;
  }catch(e){}
  setTimeout(poll,800);
}
document.getElementById('retry').onclick=async()=>{await fetch(base+'/start',{method:'POST'});document.getElementById('err').textContent='';poll()};
poll();
</script>`, html.EscapeString(mc.Label()), "/api/m/"+mc.ID()+"/code")
}

func (s *Server) handleCodeStatus(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	st := s.cs.Status(mc.ID())
	st.Ready = s.cs.Ready(mc)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleCodeStart(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	s.cs.Invalidate(mc.ID())
	go s.cs.Ensure(context.Background(), mc)
	writeJSON(w, http.StatusAccepted, s.cs.Status(mc.ID()))
}

// handleCodeStop releases a machine's code-server (allowed in read-only mode:
// it only frees resources).
func (s *Server) handleCodeStop(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	s.audit.log(r, "code_server.stop", map[string]any{"machine": mc.ID()})
	if err := s.cs.Stop(ctx, mc); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
