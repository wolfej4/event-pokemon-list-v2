(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var CART_KEY = "n3dcat-cart";
  var KIOSK_KEY = "n3dcat-kiosk";

  var designs = [], bySlug = {}, settings = {}, filter = { cat:"all", q:"" };
  var cart = loadCart();
  var lastFocus = null;

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
  function money(cents){ return (cents/100).toLocaleString("en-US", { style:"currency", currency: settings.currency || "USD" }); }

  function loadCart(){ try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch(e){ return {}; } }
  function saveCart(){ try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch(e){} updateCount(); }
  function cartCount(){ var n = 0; for (var k in cart) if (bySlug[k]) n += cart[k]; return n; }
  function updateCount(){ $("quote-count").textContent = cartCount(); }

  function toast(msg, ms){
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function(){ t.hidden = true; }, ms || 1800);
  }

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
    for (var k in cart) if (!bySlug[k]) delete cart[k];
    saveCart();
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
    $("result-count").textContent = list.length + (list.length === 1 ? " design" : " designs");
    $("empty").hidden = list.length > 0 || designs.length === 0;
    if (!designs.length) $("result-count").textContent = "No designs are listed yet.";
    $("grid").innerHTML = list.map(function(d){
      var p = d.pokemon;
      var meta = p ? ((p.pokedex_number ? "#" + p.pokedex_number + " " : "") + (p.types || []).join(" / ")) : (d.category || "");
      var n = cart[d.slug] || 0;
      return '<article class="card" data-slug="' + esc(d.slug) + '" tabindex="0" role="button" aria-label="' + esc(d.title) + '">' +
        '<div class="thumb">' + (d.image_url ? '<img loading="lazy" alt="" src="' + esc(safeUrl(d.image_url)) + '">' : '') +
        (d.is_extra ? '<span class="tag">Limited</span>' : '') + '</div>' + spool(d) +
        '<div class="card-body"><div class="card-title">' + esc(d.title) + '</div>' +
        '<div class="card-meta">' + esc(meta) + '</div>' +
        '<div class="card-foot"><span class="price">' + priceHtml(d) + '</span>' +
        '<button type="button" class="add' + (n ? ' in' : '') + '" data-add="' + esc(d.slug) + '">' + (n ? "Added \u00d7" + n : "Add") + '</button></div>' +
        '</div></article>';
    }).join("");
  }

  $("grid").addEventListener("click", function(e){
    var add = e.target.closest("[data-add]");
    if (add){ e.stopPropagation(); addToCart(add.dataset.add); return; }
    var card = e.target.closest(".card"); if (card) openDetail(card.dataset.slug);
  });
  $("grid").addEventListener("keydown", function(e){
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")){ e.preventDefault(); openDetail(e.target.dataset.slug); }
  });

  function addToCart(slug, qty){
    cart[slug] = (cart[slug] || 0) + (qty || 1);
    saveCart(); render();
    toast("Added " + bySlug[slug].title);
  }

  // ---------- detail ----------
  function openOverlay(el){ lastFocus = document.activeElement; el.hidden = false; document.body.style.overflow = "hidden"; }
  function closeOverlay(el){ el.hidden = true; if ($("detail").hidden && $("drawer").hidden) document.body.style.overflow = ""; if (lastFocus) lastFocus.focus(); }

  function openDetail(slug){
    var d = bySlug[slug]; if (!d) return;
    var p = d.pokemon;
    var h = '<div class="media">' + (d.image_url ? '<img alt="' + esc(d.title) + '" src="' + esc(safeUrl(d.image_url)) + '">' : '') + spool(d) + '</div>';
    h += '<div class="info"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
      '<h2 id="detail-title">' + esc(d.title) + '</h2><button type="button" class="btn ghost small" data-close>Close</button></div>';
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
    h += '<div class="actions"><button type="button" class="btn primary" data-detail-add="' + esc(d.slug) + '">Add to cart</button>';
    if (d.shop_url && !kiosk && safeUrl(d.shop_url)) h += '<a class="btn" href="' + esc(safeUrl(d.shop_url)) + '" target="_blank" rel="noopener">Buy online</a>';
    h += '</div></div>';
    $("detail-body").innerHTML = h;
    openOverlay($("detail"));
    $("detail-body").querySelector("[data-close]").focus();
  }
  $("detail").addEventListener("click", function(e){
    if (e.target === this || e.target.closest("[data-close]")) return closeOverlay(this);
    var a = e.target.closest("[data-detail-add]");
    if (a){ addToCart(a.dataset.detailAdd); closeOverlay(this); }
  });

  // ---------- cart and checkout ----------
  var form = { name:"", email:"", phone:"", notes:"", fulfillment:"" };
  $("open-quote").addEventListener("click", openDrawer);
  $("close-drawer").addEventListener("click", function(){ closeOverlay($("drawer")); });
  $("drawer").addEventListener("click", function(e){ if (e.target === this) closeOverlay(this); });
  document.addEventListener("keydown", function(e){
    if (e.key !== "Escape") return;
    if (!$("detail").hidden) closeOverlay($("detail"));
    else if (!$("drawer").hidden) closeOverlay($("drawer"));
  });

  function openDrawer(){ renderDrawer(); openOverlay($("drawer")); $("close-drawer").focus(); }

  function cartTotal(){
    var t = 0; for (var k in cart) if (bySlug[k]) t += bySlug[k].price_cents * cart[k]; return t;
  }
  function shipCents(){ return form.fulfillment === "ship" ? (settings.shippingCents || 0) : 0; }
  function checkoutLabel(){ return settings.payOnline ? "Continue to payment" : "Place order"; }

  function renderDrawer(){
    var slugs = Object.keys(cart).filter(function(s){ return bySlug[s]; });
    var c = $("drawer-content");
    if (!slugs.length){
      c.innerHTML = '<div class="success"><h3>Your cart is empty</h3><p>Add designs from the catalog and they’ll show up here.</p>' +
        '<button type="button" class="btn primary" id="browse">Browse designs</button></div>';
      $("browse").onclick = function(){ closeOverlay($("drawer")); };
      return;
    }
    var lines = slugs.map(function(s){
      var d = bySlug[s], q = cart[s];
      return '<div class="line"><img alt="" src="' + esc(safeUrl(d.image_url)) + '">' +
        '<div><div class="t">' + esc(d.title) + '</div><div class="u">' + priceHtml(d) + ' each</div>' +
        '<button type="button" class="remove" data-remove="' + esc(s) + '">Remove</button></div>' +
        '<div class="qty"><button type="button" data-dec="' + esc(s) + '" aria-label="Decrease quantity">−</button><span>' + q +
        '</span><button type="button" data-inc="' + esc(s) + '" aria-label="Increase quantity">+</button></div></div>';
    }).join("");
    var sc = settings.shippingCents || 0;
    c.innerHTML = lines +
      '<div class="subline"><span>Subtotal</span><span id="sum-sub">' + money(cartTotal()) + '</span></div>' +
      '<form id="checkout-form" novalidate>' +
      '<fieldset class="fulfill" id="fulfill"><legend>How do you want to get it?</legend>' +
      '<label><input type="radio" name="fulfillment" value="ship"' + (form.fulfillment === "ship" ? " checked" : "") + '> Ship it to me <span class="muted">(' + (sc ? money(sc) : "free") + ')</span></label>' +
      '<label><input type="radio" name="fulfillment" value="pickup"' + (form.fulfillment === "pickup" ? " checked" : "") + '> Local pickup <span class="muted">(free)</span></label></fieldset>' +
      '<div class="field"><label for="q-name">Name</label><input id="q-name" name="name" autocomplete="name" required value="' + esc(form.name) + '"></div>' +
      '<div class="field"><label for="q-email">Email</label><input id="q-email" name="email" type="email" autocomplete="email" required value="' + esc(form.email) + '"></div>' +
      '<div class="field"><label for="q-phone">Phone (optional)</label><input id="q-phone" name="phone" type="tel" autocomplete="tel" value="' + esc(form.phone) + '"></div>' +
      '<div class="field"><label for="q-notes">Notes (optional)</label><textarea id="q-notes" name="notes" placeholder="Color requests, pickup date">' + esc(form.notes) + '</textarea></div>' +
      '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<div class="subline" id="ship-line"' + (shipCents() ? '' : ' hidden') + '><span>Shipping</span><span>' + money(sc) + '</span></div>' +
      '<div class="total"><span>Total</span><span class="v" id="sum-total">' + money(cartTotal() + shipCents()) + '</span></div>' +
      '<div class="form-error" id="form-error" role="alert"></div>' +
      '<button class="btn primary" style="width:100%;padding:13px" type="submit" id="checkout">' + checkoutLabel() + '</button>' +
      (settings.payOnline ? '<p class="fine" style="margin-top:10px;text-align:center">Secure checkout by Square.' + (form.fulfillment === "ship" ? ' You’ll enter your shipping address there.' : '') + '</p>' : '') +
      '</form>';
  }
  function updateTotals(){
    $("ship-line").hidden = !shipCents();
    $("sum-total").textContent = money(cartTotal() + shipCents());
    $("fulfill").classList.remove("invalid");
  }

  $("drawer-content").addEventListener("input", function(e){ if (e.target.name in form) form[e.target.name] = e.target.value; });
  $("drawer-content").addEventListener("change", function(e){
    if (e.target.name !== "fulfillment") return;
    form.fulfillment = e.target.value; updateTotals();
    if ($("form-error").textContent === "Choose shipping or local pickup.") $("form-error").textContent = "";
  });
  $("drawer-content").addEventListener("click", function(e){
    var b;
    if ((b = e.target.closest("[data-inc]"))) { cart[b.dataset.inc] = Math.min(999, cart[b.dataset.inc] + 1); }
    else if ((b = e.target.closest("[data-dec]"))) { cart[b.dataset.dec]--; if (cart[b.dataset.dec] < 1) delete cart[b.dataset.dec]; }
    else if ((b = e.target.closest("[data-remove]"))) { delete cart[b.dataset.remove]; }
    else return;
    saveCart(); render(); renderDrawer();
  });
  $("drawer-content").addEventListener("submit", function(e){
    e.preventDefault();
    var f = e.target, err = $("form-error"), btn = $("checkout");
    err.textContent = "";
    if (!form.fulfillment) {
      err.textContent = "Choose shipping or local pickup.";
      $("fulfill").classList.add("invalid");
      $("fulfill").scrollIntoView({ behavior:"smooth", block:"center" });
      return f.querySelector('input[name="fulfillment"]').focus({ preventScroll:true });
    }
    if (!form.name.trim()) { err.textContent = "Enter your name."; return f.name.focus(); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { err.textContent = "Enter a valid email address."; return f.email.focus(); }
    btn.disabled = true; btn.textContent = "Placing order…";
    fetch("/api/public/quotes", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        name: form.name, email: form.email, phone: form.phone, notes: form.notes, fulfillment: form.fulfillment,
        website: f.website.value, kiosk: kiosk,
        items: Object.keys(cart).map(function(s){ return { slug:s, qty:cart[s] }; })
      })
    }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
      .then(function(res){
        if (!res.ok) throw new Error(res.j.error || "Your order didn’t go through. Try again.");
        cart = {}; saveCart(); render();
        form = { name:"", email:"", phone:"", notes:"", fulfillment:"" };
        var j = res.j, pay = safeUrl(j.pay_url);
        // on their own device, go straight to Square's checkout
        if (pay && !kiosk) {
          $("drawer-content").innerHTML = '<div class="success"><h3>Taking you to checkout…</h3>' +
            '<p>Order ' + esc(j.id) + ', ' + esc(j.total) + '.</p><a class="btn primary pay" href="' + esc(pay) + '">Continue to payment</a></div>';
          location.href = pay;
          return;
        }
        var body = pay
          ? '<div class="pay-qr"><div class="qr">' + (j.pay_qr || "") + '</div><p><strong>Scan with your phone to pay ' + esc(j.total) + '.</strong>' + (j.emailed ? '<br>We also emailed you the payment link.' : '') + '</p></div>'
          : '<p>Total: <strong>' + esc(j.total) + '</strong>. ' + (j.emailed ? "We emailed you a confirmation." : "") + ' We’ll be in touch about payment.</p>';
        $("drawer-content").innerHTML = '<div class="success"><h3>Order ' + esc(j.id) + ' placed</h3>' + body +
          '<button type="button" class="btn' + (pay ? '' : ' primary') + '" id="new-order">' + (kiosk ? "Done" : "Keep shopping") + '</button></div>';
        $("new-order").onclick = function(){ closeOverlay($("drawer")); };
      })
      .catch(function(ex){ err.textContent = ex.message; btn.disabled = false; btn.textContent = checkoutLabel(); });
  });

  // ---------- kiosk idle reset ----------
  if (kiosk){
    var idleTimer;
    var reset = function(){
      cart = {}; saveCart(); form = { name:"", email:"", phone:"", notes:"", fulfillment:"" };
      $("detail").hidden = true; $("drawer").hidden = true; document.body.style.overflow = "";
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
