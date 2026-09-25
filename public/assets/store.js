(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var KIOSK_KEY = "n3dcat-kiosk";

  var designs = [], bySlug = {}, settings = {}, filter = { cat:"all", q:"" };
  var lastFocus = null;
  var shown = [], currentSlug = null; // grid order, for stepping through designs in the detail view

  // ---------- kiosk mode (?kiosk=1 to turn on for this device, ?kiosk=0 to turn off) ----------
  var params = new URLSearchParams(location.search);
  try {
    if (params.get("kiosk") === "1") localStorage.setItem(KIOSK_KEY, "1");
    if (params.get("kiosk") === "0") localStorage.removeItem(KIOSK_KEY);
  } catch(e){}
  var kiosk = false;
  try { kiosk = localStorage.getItem(KIOSK_KEY) === "1"; } catch(e){}
  if (kiosk) document.body.classList.add("kiosk");

  // muted versions of the mainline games' type colors, tuned to work on both themes
  var TYPE_COLORS = {
    normal:"#9AA1A1", fire:"#E68A3C", water:"#5B9BE0", electric:"#E6C846", grass:"#63BC63",
    ice:"#79D0D0", fighting:"#C4534B", poison:"#9B57A6", ground:"#C9A25E",
    flying:"#8FA8E6", psychic:"#E06E96", bug:"#9BBA3E", rock:"#B8A257", ghost:"#6E5896",
    dragon:"#7460E0", dark:"#6E5C50", steel:"#8E9BAA", fairy:"#E390C9"
  };
  function typeColor(t){ return TYPE_COLORS[String(t || "").toLowerCase()] || "var(--accent)"; }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function safeUrl(u){ return /^https?:\/\//i.test(u || "") ? u : ""; }
  function safeColor(c){ return /^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#888"; }

  // the site used to have a cart; clear what older visits left behind
  try { localStorage.removeItem("n3dcat-cart"); } catch(e){}

  // ---------- load ----------
  Promise.all([
    fetch("/api/public/settings").then(function(r){ return r.json(); }),
    fetch("/api/public/designs").then(function(r){ return r.json(); })
  ]).then(function(res){
    settings = res[0] || {};
    designs = (res[1] && res[1].data) || [];
    designs.forEach(function(d){ bySlug[d.slug] = d; });
    var name = settings.businessName || "Design Catalog";
    document.title = name;
    $("brand").textContent = name;
    applyLogo(settings.logo, settings.logoShowName);
    $("hero-title").textContent = name;
    $("hero-tagline").textContent = settings.tagline || "";
    $("site-footer").textContent = "Every design is 3D printed to order. Prices include tax.";
    render();
  }).catch(function(){
    $("result-count").textContent = "The catalog didn't load. Check your connection and refresh the page.";
  });

  function applyLogo(logo, showName){
    var light = $("logo-light"), dark = $("logo-dark");
    if (!logo || !logo.light) return;
    light.src = logo.light; dark.src = logo.dark;
    light.alt = dark.alt = settings.businessName || "Logo";
    light.hidden = false;
    // only render the second <img> when a real dark version exists
    var distinct = logo.dark !== logo.light;
    dark.hidden = !distinct;
    light.classList.toggle("has-dark", distinct);
    dark.classList.toggle("has-light", distinct);
    if (showName === false) { $("brand").classList.add("sr-only"); light.alt = dark.alt = ""; }
  }

  // ---------- filters ----------
  $("search").addEventListener("input", function(e){ filter.q = e.target.value.trim().toLowerCase(); render(); });
  $("chips").addEventListener("click", function(e){
    var b = e.target.closest(".chip"); if (!b) return;
    [].forEach.call(this.querySelectorAll(".chip"), function(c){ c.classList.toggle("active", c === b); });
    filter.cat = b.dataset.cat; render();
  });
  $("clear-filters").addEventListener("click", function(){ $("search").value = ""; filter.q = ""; render(); });

  function matches(d){
    if (filter.cat !== "all" && d.category !== filter.cat) return false;
    if (!filter.q) return true;
    var p = d.pokemon || {};
    var hay = [d.title, d.slug, p.name, p.pokedex_number, (p.types || []).join(" ")].join(" ").toLowerCase();
    return filter.q.split(/\s+/).every(function(w){ return hay.indexOf(w) !== -1; });
  }

  function spool(d){
    var f = (d.filaments || []).filter(function(x){ return x.weight_grams > 0; });
    if (!f.length) return '<div class="spool" aria-hidden="true"></div>';
    var total = f.reduce(function(s,x){ return s + x.weight_grams; }, 0);
    return '<div class="spool" aria-hidden="true">' + f.map(function(x){
      return '<span style="flex:' + (x.weight_grams/total).toFixed(4) + ';background:' + safeColor(x.hex_color) + '"></span>';
    }).join("") + '</div>';
  }

  function priceHtml(d){
    return esc(d.price);
  }

  function render(){
    var list = designs.filter(matches);
    shown = list.map(function(d){ return d.slug; });
    $("result-count").textContent = list.length + (list.length === 1 ? " design" : " designs");
    $("empty").hidden = list.length > 0 || designs.length === 0;
    if (!designs.length) $("result-count").textContent = "No designs are listed yet.";
    $("grid").innerHTML = list.map(function(d){
      var p = d.pokemon;
      var meta = p ? ((p.pokedex_number ? "#" + p.pokedex_number + " " : "") + (p.types || []).join(" / ")) : (d.category || "");
      return '<article class="card" data-slug="' + esc(d.slug) + '" tabindex="0" role="button" aria-label="' + esc(d.title) + '">' +
        '<div class="thumb">' + (d.image_url ? '<img loading="lazy" alt="" src="' + esc(safeUrl(d.image_url)) + '">' : '') +
        (d.is_extra ? '<span class="tag">Limited</span>' : '') + '</div>' + spool(d) +
        '<div class="card-body"><div class="card-title">' + esc(d.title) + '</div>' +
        '<div class="card-meta">' + esc(meta) + '</div>' +
        '<div class="card-foot"><span class="price">' + priceHtml(d) + '</span></div>' +
        '</div></article>';
    }).join("");
  }

  $("grid").addEventListener("click", function(e){
    var card = e.target.closest(".card"); if (card) openDetail(card.dataset.slug);
  });
  $("grid").addEventListener("keydown", function(e){
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")){ e.preventDefault(); openDetail(e.target.dataset.slug); }
  });

  // ---------- detail ----------
  function openOverlay(el){ lastFocus = document.activeElement; el.hidden = false; document.body.style.overflow = "hidden"; }
  function closeOverlay(el){ el.hidden = true; document.body.style.overflow = ""; if (lastFocus) lastFocus.focus(); }

  // dir: +1 / -1 when stepping from the neighboring design (slides the new one in)
  function openDetail(slug, dir){
    var d = bySlug[slug]; if (!d) return;
    var p = d.pokemon;
    var i = shown.indexOf(slug), n = shown.length;
    currentSlug = slug;
    var h = '<div class="media">' + (d.image_url ? '<img alt="' + esc(d.title) + '" src="' + esc(safeUrl(d.image_url)) + '">' : '') + spool(d) + '</div>';
    h += '<div class="info"><div class="detail-top">' +
      (i > -1 && n > 1 ? '<div class="detail-nav">' +
        '<button type="button" class="btn ghost small" data-nav="-1" aria-label="Previous design"' + (i === 0 ? " disabled" : "") + '>\u2039</button>' +
        '<span class="pos">' + (i + 1) + ' of ' + n + '</span>' +
        '<button type="button" class="btn ghost small" data-nav="1" aria-label="Next design"' + (i === n - 1 ? " disabled" : "") + '>\u203a</button></div>' : '<span></span>') +
      '<button type="button" class="btn ghost small" data-close>Close</button></div>' +
      '<h2 id="detail-title">' + esc(d.title) + '</h2>';
    if (p && p.types && p.types.length) h += '<div class="types">' + p.types.map(function(t){
      return '<span style="--t-color:' + typeColor(t) + '">' + esc(t) + '</span>';
    }).join("") + '</div>';
    if (p && p.description) h += '<p class="flavor">' + esc(p.description) + '</p>';
    h += '<dl class="specs"><div><dt>Price</dt><dd>' + priceHtml(d) + '</dd></div>' +
      '<div><dt>Print time</dt><dd>' + esc(d.print_time || "\u2014") + '</dd></div>' +
      '<div><dt>Weight</dt><dd>' + (d.total_weight_grams ? Math.round(d.total_weight_grams) + " g" : "\u2014") + '</dd></div></dl>';
    if (d.filaments && d.filaments.length){
      h += '<ul class="filaments">' + d.filaments.map(function(f){
        return '<li><span class="swatch" style="background:' + safeColor(f.hex_color) + '"></span>' + esc(f.color) +
          (f.series ? ' <span style="color:var(--faint)">' + esc(f.series) + '</span>' : '') +
          '<span class="g">' + (f.weight_grams ? Math.round(f.weight_grams) + " g" : "") + '</span></li>';
      }).join("") + '</ul>';
    }
    if (d.shop_url && !kiosk && safeUrl(d.shop_url)) h += '<div class="actions"><a class="btn primary" href="' + esc(safeUrl(d.shop_url)) + '" target="_blank" rel="noopener">Buy online</a></div>';
    h += '</div>';
    var body = $("detail-body");
    body.innerHTML = h;
    body.scrollTop = 0;
    if (dir) {
      body.classList.remove("from-left", "from-right");
      void body.offsetWidth; // restart the slide animation
      body.classList.add(dir > 0 ? "from-right" : "from-left");
      var keep = body.querySelector('[data-nav="' + dir + '"]:not([disabled])');
      (keep || body.querySelector("[data-close]")).focus();
    } else {
      openOverlay($("detail"));
      body.querySelector("[data-close]").focus();
    }
    // warm up the neighbors' photos so swiping feels instant
    [shown[i - 1], shown[i + 1]].forEach(function(s){ if (s && bySlug[s].image_url) new Image().src = safeUrl(bySlug[s].image_url); });
  }
  function step(dir){
    var i = shown.indexOf(currentSlug), next = shown[i + dir];
    if (i > -1 && next) openDetail(next, dir);
  }
  $("detail").addEventListener("click", function(e){
    if (e.target === this || e.target.closest("[data-close]")) return closeOverlay(this);
    var nav = e.target.closest("[data-nav]");
    if (nav) step(Number(nav.dataset.nav));
  });
  document.addEventListener("keydown", function(e){
    if ($("detail").hidden) return;
    if (e.key === "Escape") closeOverlay($("detail"));
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  });
  // swipe left for the next design, right for the previous one
  var touch = null;
  $("detail-body").addEventListener("touchstart", function(e){
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  $("detail-body").addEventListener("touchend", function(e){
    if (!touch) return;
    var t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y, quick = Date.now() - touch.t < 800;
    touch = null;
    if (quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  // ---------- kiosk idle reset ----------
  if (kiosk){
    var idleTimer;
    var reset = function(){
      $("detail").hidden = true; document.body.style.overflow = "";
      $("search").value = ""; filter = { cat:"all", q:"" };
      [].forEach.call(document.querySelectorAll(".chip"), function(c){ c.classList.toggle("active", c.dataset.cat === "all"); });
      render(); window.scrollTo(0, 0);
    };
    var bump = function(){
      clearTimeout(idleTimer);
      idleTimer = setTimeout(reset, (settings.kioskIdleSeconds || 90) * 1000);
    };
    ["pointerdown","keydown","scroll","touchstart"].forEach(function(ev){ document.addEventListener(ev, bump, { passive:true }); });
    bump();
  }
})();
