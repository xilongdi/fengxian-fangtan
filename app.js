(function(){
"use strict";

var GRID = 0.02;
var state = {
  dict: null, summary: null, tileIndex: null,
  blocks: {},          // key -> 已解析数组
  loading: {},         // key -> Promise
  loaded: {},          // key -> bool
  hidden: {},          // landcode -> bool
  planLayer: null, planOn: false, baseOn: true,
  selected: null, markers: null,
  drawn: {},           // key -> L.LayerGroup（该切片已绘制的图层）
  viewKey: "",         // 上次绘制时的视野签名
  renderToken: 0,      // 防抖/取消用
  pendingTimer: null
};

var lm, baseLayer, planGroup, blockGroup, hlLayer;

/* ---------- 工具 ---------- */
/* 支持 .json.gz 预压缩数据：浏览器带 DecompressionStream 时直接解压；
   否则退回普通 .json（本地 python 服务器会自动 gzip 传输） */
var USE_GZ = (typeof DecompressionStream !== "undefined") && location.protocol !== "file:";
function fetchJSON(path){
  var url = USE_GZ ? (path + ".gz") : path;
  return fetch(url).then(function(r){
    if(!r.ok) throw new Error(r.status + " " + url);
    if(USE_GZ && typeof DecompressionStream !== "undefined"){
      var ds = new DecompressionStream("gzip");
      return new Response(r.body.pipeThrough(ds)).json();
    }
    return r.json();
  }).catch(function(e){
    // 回退：如果 .gz 取不到，试原始 json
    if(USE_GZ) return fetch(path).then(function(r){ return r.json(); });
    throw e;
  });
}

function el(id){ return document.getElementById(id); }
function fmt(n, d){
  if(n===null||n===undefined||n==="") return null;
  var v = Number(n);
  if(isNaN(v)) return null;
  return d===undefined ? v.toLocaleString("zh-CN") : v.toFixed(d);
}
function colorOf(code){
  // 用哈希生成稳定的颜色，若无图例色
  var h=0; for(var i=0;i<(code||"").length;i++) h=(h*31+code.charCodeAt(i))|0;
  var hue=Math.abs(h)%360;
  return "hsl("+hue+",55%,58%)";
}

/* ---------- 初始化 ---------- */
function init(){
  lm = L.map(document.getElementById("map"), {
    center:[30.917, 121.474], zoom:12,
    zoomControl:false, preferCanvas:true,
    minZoom:10, maxZoom:19
  });
  L.control.zoom({position:"bottomleft"}).addTo(lm);
  L.control.scale({position:"bottomleft", imperial:false}).addTo(lm);

  // 底图：天地图矢量（via 上海测绘院代理）
  var KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBsaWNhdGlvbl9pZCI6NTQsImFwcGxpY2F0aW9uX25hbWUiOiLmtYvnu5jpmaLmtYvor5XlupTnlKgiLCJleHAiOjE3NjEzNjMxNDJ9.y7xn4ydvF2W3wCwRH7iimyyG8tXGB1fxQuGQzdsuSyg";
  baseLayer = L.tileLayer(
    "https://service-api.onemap.sh.gov.cn/data-service-manage-service/MapProxyApi/"+KEY+"/shmap_normal_web/MapServer/tile/{z}/{y}/{x}?key="+KEY,
    {maxZoom:19, attribution:"底图 © 上海市测绘院 / 天地图上海"}
  ).addTo(lm);

  blockGroup = L.layerGroup().addTo(lm);
  planGroup  = L.layerGroup();
  hlLayer    = L.layerGroup().addTo(lm);

  lm.on("moveend", refresh);
  lm.on("zoomend", refresh);
  lm.on("click", function(e){ queryAt(e.latlng); });

  Promise.all([
    fetchJSON("data/dict.json"),
    fetchJSON("data/summary.json"),
    fetchJSON("data/tileindex.json")
  ]).then(function(a){
    state.dict = a[0]; state.summary = a[1]; state.tileIndex = a[2];
    renderStats(); renderLegend(); refresh();
  }).catch(function(e){
    el("loading").textContent = "数据加载失败：" + e.message;
    el("loading").classList.add("show");
  });
}

/* ---------- 统计 ---------- */
function renderStats(){
  var s = state.summary;
  el("stats").innerHTML =
    '<div class="row"><span>地块总数</span><span>'+fmt(s.blocks)+'</span></div>'+
    '<div class="row"><span>规划范围</span><span>'+fmt(s.planscope)+'</span></div>'+
    '<div class="row"><span>用地性质分类</span><span>'+s.by_landuse.length+'</span></div>';
}

/* ---------- 图例 ---------- */
function renderLegend(){
  var s = state.summary, LU = state.dict.landuse;
  var html = '<h2>用地性质</h2>';
  s.by_landuse.forEach(function(item){
    var c = item.color ? "rgb("+item.color.join(",")+")" : colorOf(item.code);
    html += '<div class="li" data-code="'+(item.code||"")+'">'+
      '<i class="sw" style="background:'+c+'"></i>'+
      '<span class="nm" title="'+item.name+'">'+item.name+'</span>'+
      '<span class="ct">'+item.n.toLocaleString("zh-CN")+'</span></div>';
  });
  el("legend").innerHTML = html;
  el("legend").querySelectorAll(".li").forEach(function(node){
    node.onclick = function(){
      var code = node.getAttribute("data-code");
      state.hidden[code] = !state.hidden[code];
      node.classList.toggle("off", state.hidden[code]);
      // 仅对已绘制图层做增删，不重建对象
      toggleLanduse(code, !state.hidden[code]);
    };
  });
}

/* ---------- 视野内切片 ---------- */
function visibleTiles(){
  var b = lm.getBounds();
  var out = [];
  for(var k in state.tileIndex){
    var tb = state.tileIndex[k].b; // [minx,miny,maxx,maxy]
    if(tb[2] < b.getWest() || tb[0] > b.getEast()) continue;
    if(tb[3] < b.getSouth() || tb[1] > b.getNorth()) continue;
    out.push(k);
  }
  return out;
}

/* 缩放/拖动结束：立即安排绘制，但绝不阻塞交互 */
function refresh(){
  scheduleDraw(0);
  loadVisibleTiles();
}

/* 异步加载视野内的切片，不阻塞任何交互 */
function loadVisibleTiles(){
  var keys = visibleTiles();
  var need = keys.filter(function(k){ return !state.loaded[k] && !state.loading[k]; });
  if(need.length === 0) return;

  var done = 0, total = need.length;
  need.forEach(function(k){
    state.loading[k] = fetchJSON("data/t_"+k+".json")
      .then(function(arr){
        state.blocks[k] = arr;
        state.loaded[k] = true;
        delete state.loading[k];
      })
      .catch(function(){
        state.loaded[k] = true;
        delete state.loading[k];
      })
      .then(function(){
        done++;
        syncLoading(done, total);
        // 该切片到了：如果它现在仍在视野内，只增量绘制它
        if(isTileVisible(k)){
          drawTile(k);
        }
      });
  });
  syncLoading(0, total);
}

function syncLoading(done, total){
  var ld = el("loading");
  var remain = total - done;
  if(remain > 0){
    ld.textContent = "加载 " + remain + " 个数据块…";
    ld.classList.add("show");
  } else {
    ld.classList.remove("show");
  }
}

function isTileVisible(k){
  var tb = state.tileIndex[k]; if(!tb) return false;
  var b = lm.getBounds();
  if(tb.b[2] < b.getWest() || tb.b[0] > b.getEast()) return false;
  if(tb.b[3] < b.getSouth() || tb.b[1] > b.getNorth()) return false;
  return true;
}

/* ---------- 绘制（按切片增量 + 空闲调度） ---------- */

/* 空出主线程后再绘制，保证缩放/拖动立即响应 */
function scheduleDraw(delay){
  if(state.pendingTimer) clearTimeout(state.pendingTimer);
  state.pendingTimer = setTimeout(function(){
    state.pendingTimer = null;
    var run = function(){ syncVisibleLayers(); };
    if(window.requestIdleCallback){
      window.requestIdleCallback(run, {timeout: 300});
    } else {
      setTimeout(run, 0);
    }
  }, delay || 0);
}

/* 只处理"此刻应显示"与"当前已显示"的差集，不做全量重建 */
function syncVisibleLayers(){
  var need = visibleTiles();
  var needSet = {};
  need.forEach(function(k){ needSet[k] = 1; });

  // 1) 移除移出视野的切片
  Object.keys(state.drawn).forEach(function(k){
    if(!needSet[k]){
      blockGroup.removeLayer(state.drawn[k]);
      delete state.drawn[k];
    }
  });

  // 缩放级别变化时，地块筛选条件不同，需要重绘所有切片
  var z = lm.getZoom();
  if(state.drawnZoom !== undefined && state.drawnZoom !== z){
    Object.keys(state.drawn).forEach(function(k){
      if(k === "_index") return;
      blockGroup.removeLayer(state.drawn[k]);
      delete state.drawn[k];
    });
    state.drawn._index = null;
  }
  state.drawnZoom = z;

  // 2) 绘制新进入视野的切片（分批，避免一次性长时间占用）
  var toDraw = need.filter(function(k){ return !state.drawn[k] && state.blocks[k]; });
  drawBatch(toDraw, 0);
}

function drawBatch(keys, idx){
  if(idx >= keys.length) return;
  var BATCH = 3;                     // 每次最多画 3 个切片
  var end = Math.min(idx + BATCH, keys.length);
  for(var i = idx; i < end; i++){
    drawTile(keys[i]);
  }
  if(end < keys.length){
    // 让出主线程再继续
    setTimeout(function(){ drawBatch(keys, end); }, 0);
  }
}

/* 绘制单个切片，结果缓存在 state.drawn[k] */
function drawTile(k){
  if(state.drawn[k]) return;
  var arr = state.blocks[k]; if(!arr) return;
  var colors = state.dict.legend_colors;
  var hidden = state.hidden;
  var g = L.layerGroup();

  // 低缩放级别时，屏幕像素太小的小地块直接跳过（人眼也看不清）
  var z = lm.getZoom();
  // z<=11: 只画 >8000m²; z12: >2500m²; z13: >800m²; z14+: 全画
  var minArea = z <= 11 ? 8000 : (z === 12 ? 2500 : (z === 13 ? 800 : 0));

  for(var i = 0; i < arr.length; i++){
    var item = arr[i];
    var p = item.p;
    var code = p.lu || "";
    if(hidden[code]) continue;
    if(minArea && p.area && p.area < minArea) continue;
    var c = colors[code] ? "rgb("+colors[code].join(",")+")" : colorOf(code);
    var rings = item.g.map(function(ring){
      return ring.map(function(pt){ return [pt[1], pt[0]]; });
    });
    var poly = L.polygon(rings, {
      color: "rgba(255,255,255,.35)", weight: .6,
      fillColor: c, fillOpacity: .72, opacity: .85,
      smoothFactor: 1,                 // 适度简化绘制开销
      interactive: true
    });
    poly._data = item;
    poly.on("mouseover", onPolyOver);
    poly.on("mouseout", onPolyOut);
    poly.on("click", onPolyClick);
    g.addLayer(poly);
  }
  blockGroup.addLayer(g);
  state.drawn[k] = g;
}

function onPolyOver(){ this.setStyle({weight:2.4, color:"#fff", fillOpacity:.92}); }
function onPolyOut(){ this.setStyle({weight:.6, color:"rgba(255,255,255,.35)", fillOpacity:.72}); }
function onPolyClick(e){
  L.DomEvent.stopPropagation(e);
  highlight(this._data);
}

/* 图例筛选：对已绘制的图层组做增删，避免重建 */
function toggleLanduse(code, show){
  Object.keys(state.drawn).forEach(function(k){
    var arr = state.blocks[k]; if(!arr) return;
    var g = state.drawn[k];
    var wantMap = {};
    // 建立 item -> layer 的快速映射（首次使用）
    if(!state.drawn._index) state.drawn._index = {};
    var idx = state.drawn._index[k];
    if(!idx){
      idx = state.drawn._index[k] = [];
      var layers = g.getLayers();
      for(var i = 0; i < layers.length; i++){
        idx.push({ item: layers[i]._data, layer: layers[i] });
      }
    }
    for(var i = 0; i < idx.length; i++){
      var it = idx[i];
      var c = (it.item.p.lu || "");
      if(c !== code) continue;
      if(show){ if(!g.hasLayer(it.layer)) g.addLayer(it.layer); }
      else { if(g.hasLayer(it.layer)) g.removeLayer(it.layer); }
    }
  });
}

/* 兼容旧调用：图例筛选等需要全量重建 */
function drawAll(){
  Object.keys(state.drawn).forEach(function(k){
    blockGroup.removeLayer(state.drawn[k]);
  });
  state.drawn = {};
  syncVisibleLayers();
}

/* ---------- 点击地图查最近地块 ---------- */
function queryAt(latlng){
  var best = null;
  var x = latlng.lng, y = latlng.lat;
  var keys = visibleTiles();          // 只扫视野内切片
  for(var i = 0; i < keys.length; i++){
    var arr = state.blocks[keys[i]];
    if(!arr) continue;
    for(var j = 0; j < arr.length; j++){
      var item = arr[j];
      if(ptInPoly(x, y, item.g[0]) === 0){ best = item; break; }
    }
    if(best) break;
  }
  if(best) highlight(best);
  else showDetail(null);
}

function ptInPoly(x, y, ring){
  var inside = false;
  for(var i=0, j=ring.length-1; i<ring.length; j=i++){
    var xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside ? 0 : 1;
}

function highlight(item){
  hlLayer.clearLayers();
  state.selected = item;
  var rings = item.g.map(function(ring){
    return ring.map(function(pt){ return [pt[1], pt[0]]; });
  });
  L.polygon(rings, {color:"#fff", weight:2.5, fillColor:"#fff", fillOpacity:.12}).addTo(hlLayer);
  showDetail(item);
}

/* ---------- 详情 ---------- */
function showDetail(item){
  var d = el("detail");
  if(!item){ d.classList.remove("show"); return; }
  var p = item.p, LU = state.dict.landuse, DYN = state.dict.dynamic;
  var rows = [];
  function row(k, v, cls){
    if(v===null||v===undefined||v==="") return;
    rows.push('<div class="f"><span class="k">'+k+'</span><span class="v '+(cls||'')+'">'+v+'</span></div>');
  }
  row("地块编号", p.no);
  row("用地性质",
      (LU[p.lu]||p.lu||"—") + (p.lu?' <span class="badge">'+p.lu+'</span>':""));
  if(p.bl) row("混合用地", LU[p.bl]||p.bl);
  row("用地面积", p.area ? fmt(p.area,2)+" m²" : null);
  row("建筑高度", (p.hmax?p.hmax+" m":"—") + (p.hmin?" ~ "+p.hmin+" m":""));
  row("容积率", p.fmax!==undefined? p.fmax : (p.far!==undefined? p.far: "—"));
  row("规划动态", DYN[p.dyn]||p.dyn||"—");
  row("所属规划", p.pname);
  row("批文号", p.appr);
  row("项目编号", p.pno);

  d.querySelector(".bd").innerHTML = rows.join("");
  d.querySelector(".hd h3").textContent = p.no || "地块详情";
  d.classList.add("show");
}

/* ---------- 检索 ---------- */
var searchTimer = null;
function doSearch(q){
  q = (q||"").trim();
  var box = el("results");
  if(!q){ box.innerHTML=""; return; }
  var hits = [];
  for(var k in state.blocks){
    state.blocks[k].forEach(function(item){
      var p = item.p;
      var hay = [p.no, p.pname, p.appr, p.pno, p.lu, LUname(p.lu)].join(" ").toLowerCase();
      if(hay.indexOf(q.toLowerCase()) >= 0) hits.push(item);
    });
  }
  hits = hits.slice(0, 40);
  if(hits.length === 0){ box.innerHTML = '<div class="r"><span>未找到匹配（仅在已加载区域检索）</span></div>'; return; }
  box.innerHTML = hits.map(function(it,i){
    var p = it.p;
    return '<div class="r" data-i="'+i+'"><b>'+(p.no||"无编号")+'</b>'+
      '<span>'+(LUname(p.lu))+' · '+(p.pname||"")+'</span></div>';
  }).join("");
  box.querySelectorAll(".r").forEach(function(node){
    node.onclick = function(){
      var it = hits[+node.getAttribute("data-i")];
      var c = it.g[0][0];
      lm.setView([c[1], c[0]], 17);
      setTimeout(function(){ highlight(it); }, 400);
    };
  });
}
function LUname(code){ return (state.dict && state.dict.landuse[code]) || code || "未标注"; }

/* ---------- 事件绑定 ---------- */
el("closeDetail").onclick = function(){ showDetail(null); hlLayer.clearLayers(); };
el("searchBox").oninput = function(){
  clearTimeout(searchTimer);
  var v = this.value;
  searchTimer = setTimeout(function(){ doSearch(v); }, 220);
};

var btnPlan = el("togPlan");
btnPlan.addEventListener("click", function(){
  state.planOn = !state.planOn;
  btnPlan.classList.toggle("on", state.planOn);
  if(state.planOn){
    lm.addLayer(planGroup);
    if(!state.plansLoaded){
      state.plansLoaded = true;
      var ld = el("loading");
      ld.textContent = "加载规划范围…";
      ld.classList.add("show");
      loadPlans();
    }
  } else {
    lm.removeLayer(planGroup);
  }
});

function loadPlans(){
  fetchJSON("data/planscope.json").catch(function(){ return []; }).then(function(arr){
    if(!arr || !arr.length){ el("loading").classList.remove("show"); return; }
    arr.forEach(function(item){
      var rings = item.g.map(function(ring){
        return ring.map(function(pt){ return [pt[1], pt[0]]; });
      });
      var poly = L.polygon(rings, {
        color:"#f0b429", weight:2, dashArray:"6 4", fill:false, opacity:.9
      });
      var p = item.p;
      poly.bindTooltip(
        '<b>'+(p.pname||"")+'</b><br>批文号：'+(p.appr||"—")+
        '<br>范围面积：'+(p.area?fmt(p.area,0)+" m²":"—"),
        {sticky:true, className:"plan-tip"}
      );
      planGroup.addLayer(poly);
    });
    var ld2 = el("loading");
    ld2.classList.remove("show");
    ld2.textContent = "";
  }).catch(function(){
    var ld3 = el("loading");
    ld3.textContent = "规划范围加载失败";
    setTimeout(function(){ ld3.classList.remove("show"); }, 2000);
  });
}

el("togBase").onclick = function(){
  state.baseOn = !state.baseOn;
  this.classList.toggle("on", state.baseOn);
  if(state.baseOn) lm.addLayer(baseLayer); else lm.removeLayer(baseLayer);
};

init();
})();