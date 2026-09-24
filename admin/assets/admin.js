(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  // every form here is saved with fetch; never let one fall back to a full
  // page reload, which would drop unsaved changes and jump back to Designs
  document.addEventListener("submit", function(e){ e.preventDefault(); }, true);
  var designs = [], settings = {}, status = {};
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function money(c){ return (c/100).toLocaleString("en-US", { style:"currency", currency: settings.currency || "USD" }); }

  function api(path, opts){
    opts = opts || {};
    if (opts.body && typeof opts.body !== "string") { opts.body = JSON.stringify(opts.body); opts.headers = { "Content-Type":"application/json" }; }
    return fetch("/api/admin" + path, opts).then(function(r){
      if (r.status === 401 && path !== "/login") { showLogin(); throw new Error("Session expired. Log in again."); }
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (!r.ok) throw new Error(j.error || (r.status >= 502 && r.status <= 504
          ? "The server didn\u2019t answer (" + r.status + " from the proxy in front of it). The app may have restarted or timed out; check the container log for the reason."
          : "Request failed (" + r.status + ")"));
        return j;
      });
    });
  }
  function setStatus(el, msg, kind){ el.textContent = msg; el.className = el.className.replace(/\b(ok|bad)\b/g, "").trim() + (kind ? " " + kind : ""); }

  // ---------- auth ----------
  function showLogin(){ stopOrderWatch(); $("app").hidden = true; $("login").hidden = false; $("pw").focus(); }
  function showApp(){ $("login").hidden = true; $("app").hidden = false; boot(); }
  $("login-form").addEventListener("submit", function(e){
    e.preventDefault(); $("login-err").textContent = "";
    api("/login", { method:"POST", body:{ password: $("pw").value } })
      .then(function(){ $("pw").value = ""; showApp(); })
      .catch(function(err){ $("login-err").textContent = err.message; });
  });
  $("logout").addEventListener("click", function(){ api("/logout", { method:"POST" }).finally(showLogin); });
  fetch("/api/admin/session").then(function(r){ return r.json(); }).then(function(s){ s.isAdmin ? showApp() : showLogin(); });

  // ---------- tabs ----------
  document.querySelector(".tabs").addEventListener("click", function(e){
    var b = e.target.closest("[data-tab]"); if (!b) return;
    // remember the tab in the URL so a reload comes back to it
    try { history.replaceState(null, "", "#" + (b.dataset.tab === "quotes" ? "orders" : b.dataset.tab)); } catch(err){}
    [].forEach.call(this.children, function(x){ x.classList.toggle("active", x === b); });
    [].forEach.call(document.querySelectorAll("[data-panel]"), function(p){ p.hidden = p.dataset.panel !== b.dataset.tab; });
    if (b.dataset.tab === "quotes") loadQuotes();
    if (b.dataset.tab === "square") { checkSquareJob(); initSquarePay(); }
    if (b.dataset.tab === "inventory") initInventory();
  });

  function boot(){
    Promise.all([api("/settings"), api("/status")]).then(function(r){
      settings = r[0]; status = r[1];
      fillSettings(); fillSmtp(); fillPricing(); renderConn(); renderLogos(); renderStorageAlert(); renderPayProblem();
      startOrderWatch();
      var tab = location.hash.slice(1) === "orders" ? "quotes" : location.hash.slice(1);
      var tabBtn = tab && document.querySelector('.tabs [data-tab="' + tab.replace(/[^a-z]/g, "") + '"]');
      if (tabBtn) tabBtn.click();
      if (settings.businessName) $("bar-title").textContent = settings.businessName + " admin";
      return loadDesigns();
    }).catch(function(e){ setStatus($("sync-status"), e.message, "bad"); });
  }

  // ---------- designs ----------
  function loadDesigns(){
    return api("/designs").then(function(r){ designs = r.data || []; renderRows(); renderPreview(); });
  }
  $("d-search").addEventListener("input", renderRows);
  $("d-filter").addEventListener("change", renderRows);

  function squareCell(d){
    if (d.square_error) return '<span class="pill bad" title="' + esc(d.square_error) + '">Error</span>';
    if (d.square_item_id) return '<span class="pill ok" title="Last pushed ' + esc(new Date(d.square_pushed_at).toLocaleString()) + '">In Square</span>' +
      (d.square_image_error ? ' <span class="pill warn" title="' + esc(d.square_image_error) + '">No photo</span><div class="dm pay-err">Photo: ' + esc(d.square_image_error) + '</div>' : '');
    return '<span class="pill">Not pushed</span>';
  }

  function renderRows(){
    var q = $("d-search").value.trim().toLowerCase(), f = $("d-filter").value;
    var list = designs.filter(function(d){
      if (q && ((d.title || "") + " " + d.slug).toLowerCase().indexOf(q) === -1) return false;
      if (f === "visible") return d.visible !== false;
      if (f === "hidden") return d.visible === false;
      if (f === "override") return d.price_cents != null;
      if (f === "unpushed") return !d.square_item_id;
      return true;
    });
    var vis = designs.filter(function(d){ return d.visible !== false; }).length;
    $("design-summary").textContent = designs.length ? (designs.length + " designs, " + vis + " visible on the store" +
      (settings.lastCursor ? ". Last N3D change: " + new Date(settings.lastCursor).toLocaleDateString() : "")) :
      "No designs yet. Sync from N3D to pull in your catalog.";
    $("rows").innerHTML = list.map(function(d){
      return '<tr data-slug="' + esc(d.slug) + '"' + (d.visible === false ? ' class="off"' : '') + '>' +
        '<td><img class="th" loading="lazy" alt="" src="' + esc(d.image_url || "") + '"></td>' +
        '<td><div class="dt">' + esc(d.title) + '</div><div class="dm">' + esc(d.category || "") +
          (d.total_weight_grams ? ", " + Math.round(d.total_weight_grams) + " g" : "") + (d.print_time ? ", " + esc(d.print_time) : "") + '</div></td>' +
        '<td class="muted">' + money(d.formula_cents) + '</td>' +
        '<td><input class="input price-in" type="number" min="0" step="0.01" placeholder="Formula" aria-label="Custom price" value="' +
          (d.price_cents != null ? (d.price_cents/100).toFixed(2) : "") + '"></td>' +
        '<td><input class="input url-in" type="url" placeholder="https://" aria-label="Shop link" value="' + esc(d.shop_url || "") + '"></td>' +
        '<td><input type="checkbox" class="vis" aria-label="Visible on store"' + (d.visible !== false ? " checked" : "") + '></td>' +
        '<td>' + squareCell(d) + '</td>' +
        '<td><div class="cell-actions"><button class="btn small" data-save type="button">Save</button>' +
          '<button class="btn ghost small" data-push type="button"' + (status.square ? "" : " disabled title=\"SQUARE_ACCESS_TOKEN not set\"") + '>Push</button>' +
          '<span class="saved"></span></div></td></tr>';
    }).join("");
  }

  function replaceDesign(d){
    for (var i = 0; i < designs.length; i++) if (designs[i].slug === d.slug) designs[i] = d;
  }

  $("rows").addEventListener("click", function(e){
    var btn = e.target.closest("[data-save],[data-push]"); if (!btn) return;
    var tr = btn.closest("tr"), slug = tr.dataset.slug, note = tr.querySelector(".saved");
    btn.disabled = true; note.style.color = ""; note.textContent = "";
    var p;
    if (btn.hasAttribute("data-save")) {
      p = api("/designs/" + encodeURIComponent(slug), { method:"POST", body:{
        price: tr.querySelector(".price-in").value,
        shop_url: tr.querySelector(".url-in").value,
        visible: tr.querySelector(".vis").checked
      }}).then(function(r){ replaceDesign(r.data); tr.classList.toggle("off", r.data.visible === false); note.textContent = "Saved"; });
    } else {
      note.textContent = "Pushing…";
      p = api("/square/push/" + encodeURIComponent(slug), { method:"POST" })
        .then(function(r){ replaceDesign(r.data); tr.children[6].innerHTML = squareCell(r.data); note.textContent = "Pushed"; });
    }
    p.catch(function(err){ note.style.color = "var(--bad)"; note.textContent = err.message; if (btn.hasAttribute("data-push")) loadDesigns(); })
     .finally(function(){ btn.disabled = false; setTimeout(function(){ if (note.textContent === "Saved" || note.textContent === "Pushed") note.textContent = ""; }, 2000); });
  });

  function runSync(full){
    var el = $("sync-status");
    $("sync").disabled = $("full-sync").disabled = true;
    setStatus(el, full ? "Pulling the full catalog from N3D…" : "Checking N3D for new and changed designs…");
    api("/sync", { method:"POST", body:{ full: full } })
      .then(function(r){ setStatus(el, "Sync finished: " + r.added + " new, " + r.updated + " updated.", "ok"); return api("/settings"); })
      .then(function(s){ settings = s; return loadDesigns(); })
      .catch(function(e){ setStatus(el, "Sync failed: " + e.message, "bad"); })
      .finally(function(){ $("sync").disabled = $("full-sync").disabled = false; });
  }
  $("sync").addEventListener("click", function(){ runSync(false); });
  $("full-sync").addEventListener("click", function(){ runSync(true); });

  // ---------- pricing ----------
  var PK = ["baseFee","perGram","perHour","markupPct","minPrice","roundTo","shipping"];
  function fillPricing(){ PK.forEach(function(k){ $("p-" + k).value = settings.pricing[k]; }); }
  function formPricing(){ var p = {}; PK.forEach(function(k){ p[k] = Number($("p-" + k).value) || 0; }); return p; }
  function hours(t){
    if (!t) return 0; if (typeof t === "number") return t / 3600;
    var m = String(t).match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) return +m[1] + m[2]/60 + (m[3] || 0)/3600;
    var h = 0, x;
    if ((x = /(\d+(?:\.\d+)?)\s*d/i.exec(t))) h += x[1]*24;
    if ((x = /(\d+(?:\.\d+)?)\s*h/i.exec(t))) h += +x[1];
    if ((x = /(\d+(?:\.\d+)?)\s*m/i.exec(t))) h += x[1]/60;
    return h;
  }
  function formula(d, p){ // mirrors src/pricing.js so the preview updates as you type
    var v = p.baseFee + (d.total_weight_grams || 0) * p.perGram + hours(d.print_time) * p.perHour;
    v *= 1 + p.markupPct/100; v = Math.max(v, p.minPrice);
    if (p.roundTo > 0) v = Math.ceil(v / p.roundTo - 1e-9) * p.roundTo;
    return Math.round(v * 100);
  }
  function renderPreview(){
    var p = formPricing();
    var sample = designs.filter(function(d){ return d.total_weight_grams; })
      .sort(function(a,b){ return a.total_weight_grams - b.total_weight_grams; });
    if (sample.length > 6) { var step = (sample.length - 1) / 5, pick = []; for (var i = 0; i < 6; i++) pick.push(sample[Math.round(i*step)]); sample = pick; }
    $("pricing-preview").innerHTML = sample.length ? sample.map(function(d){
      return '<div class="preview-row"><span>' + esc(d.title) + ' <span class="muted">(' + Math.round(d.total_weight_grams) + ' g, ' + esc(d.print_time || "?") + ')</span></span><strong>' + money(formula(d, p)) + '</strong></div>';
    }).join("") : '<p class="muted">Sync designs from N3D to see a preview.</p>';
  }
  $("pricing-form").addEventListener("input", renderPreview);
  $("pricing-form").addEventListener("submit", function(e){
    e.preventDefault();
    api("/settings", { method:"POST", body:{ pricing: formPricing() } })
      .then(function(s){ settings = s; setStatus($("pricing-status"), "Saved. Store prices updated.", "ok"); return loadDesigns(); })
      .catch(function(err){ setStatus($("pricing-status"), err.message, "bad"); });
  });

  // ---------- settings ----------
  var SK = ["businessName","tagline","businessEmail","businessPhone","currency","kioskIdleSeconds","quoteFooter"];
  function fillSettings(){
    SK.forEach(function(k){ $("s-" + k).value = settings[k] == null ? "" : settings[k]; });
    $("sq-overwrite").checked = settings.squareOverwritePrices !== false;
  }
  $("settings-form").addEventListener("submit", function(e){
    e.preventDefault();
    var body = {}; SK.forEach(function(k){ body[k] = $("s-" + k).value; });
    body.currency = body.currency.toUpperCase();
    api("/settings", { method:"POST", body: body })
      .then(function(s){ settings = s; fillSettings(); setStatus($("settings-status"), "Saved.", "ok"); })
      .catch(function(err){ setStatus($("settings-status"), err.message, "bad"); });
  });
  function renderConn(){
    var rows = [["N3D API key", status.n3dKey], ["Email (SMTP)", status.smtp], ["Square (" + status.squareEnv + ")", status.square]];
    $("conn-list").innerHTML = rows.map(function(r){
      return '<li><span>' + esc(r[0]) + '</span>' + (r[1] ? '<span class="pill ok">Set</span>' : '<span class="pill warn">Not set</span>') + '</li>';
    }).join("");
    $("sq-conn").textContent = status.square ? "Access token is set (" + status.squareEnv + ")." : "SQUARE_ACCESS_TOKEN isn't set. Add it to the stack's environment variables and redeploy.";
    $("sq-push-all").disabled = $("sq-test").disabled = !status.square;
  }
  $("n3d-test").addEventListener("click", function(){
    setStatus($("conn-status"), "Checking N3D key…");
    api("/n3d/check").then(function(){ setStatus($("conn-status"), "N3D key works.", "ok"); })
      .catch(function(e){ setStatus($("conn-status"), e.message, "bad"); });
  });
  function testSmtp(el){
    setStatus(el, "Connecting to the mail server…");
    api("/smtp/test", { method:"POST" }).then(function(){ setStatus(el, "Mail server accepted the login.", "ok"); })
      .catch(function(e){ setStatus(el, e.message, "bad"); });
  }
  $("smtp-test").addEventListener("click", function(){ testSmtp($("conn-status")); });

  // ---------- email (SMTP) ----------
  function fillSmtp(){
    var m = settings.smtp || {}, saved = !!m.host;
    $("smtp-host").value = m.host || "";
    $("smtp-port").value = m.port || "";
    $("smtp-secure").value = typeof m.secure === "boolean" ? String(m.secure) : "";
    $("smtp-from").value = m.from || "";
    $("smtp-user").value = m.user || "";
    $("smtp-pass").value = "";
    $("smtp-pass").placeholder = m.passSet ? "Saved (leave blank to keep)" : "";
    $("smtp-clear-pass").checked = false;
    $("smtp-clear-pass-wrap").hidden = !m.passSet;
    $("smtp-clear").hidden = !saved;
    $("smtp-source").textContent = saved ? "Using the settings below."
      : status.smtp ? "Currently using the SMTP_* environment variables. Save settings here to replace them."
      : "Not set up yet. Orders are still saved, but no emails go out.";
  }
  function refreshStatus(){ return api("/status").then(function(s){ status = s; renderConn(); fillSmtp(); }); }
  $("smtp-form").addEventListener("submit", function(e){
    e.preventDefault();
    var body = { host: $("smtp-host").value, port: $("smtp-port").value || 587, secure: $("smtp-secure").value,
      from: $("smtp-from").value, user: $("smtp-user").value, pass: $("smtp-pass").value, clearPass: $("smtp-clear-pass").checked };
    api("/smtp", { method:"POST", body: body })
      .then(function(s){ settings = s; setStatus($("smtp-status"), "Saved. Click Test email to check the login.", "ok"); return refreshStatus(); })
      .catch(function(err){ setStatus($("smtp-status"), err.message, "bad"); });
  });
  $("smtp-test-2").addEventListener("click", function(){ testSmtp($("smtp-status")); });
  $("smtp-clear").addEventListener("click", function(){
    if (!confirm("Remove the saved email settings and use the SMTP_* environment variables instead?")) return;
    api("/smtp", { method:"POST", body:{ clear:true } })
      .then(function(s){ settings = s; setStatus($("smtp-status"), "Saved settings removed.", "ok"); return refreshStatus(); })
      .catch(function(err){ setStatus($("smtp-status"), err.message, "bad"); });
  });

  function renderStorageAlert(){
    var a = $("storage-alert");
    a.hidden = !status.storageError;
    if (!status.storageError) return;
    a.innerHTML = '<strong>Changes aren\u2019t being saved to disk.</strong> The app can\u2019t write to <code>/app/data</code> (' + esc(status.storageError) +
      '). Anything you change now will be lost when the container restarts. Run this on the Docker host, then click Save settings once:<br>' +
      '<code>docker exec -u root n3d-catalog chown -R node:node /app/data</code>';
  }

  // ---------- logo ----------
  function renderLogos(){
    var logos = settings.logos || {};
    [].forEach.call(document.querySelectorAll(".logo-slot"), function(slot){
      var v = slot.dataset.variant, meta = logos[v], img = slot.querySelector("img"), empty = slot.querySelector(".muted");
      var fallback = v === "dark" && !meta && logos.light ? logos.light : null;
      var use = meta || fallback;
      img.hidden = !use; empty.hidden = !!use;
      if (use) img.src = "/api/public/logo/" + (meta ? v : "light") + "?v=" + use.v;
      slot.querySelector("[data-remove]").hidden = !meta;
    });
    var bar = $("bar-logo"), main = logos.light || logos.dark;
    bar.hidden = !main;
    if (main) {
      var dark = document.documentElement.dataset.theme === "dark";
      var v = dark && logos.dark ? "dark" : (logos.light ? "light" : "dark");
      bar.src = "/api/public/logo/" + v + "?v=" + logos[v].v;
    }
    $("logo-show-name").checked = settings.logoShowName !== false;
  }
  // swap the admin bar logo when the theme toggles
  new MutationObserver(function(){ if (settings.logos) renderLogos(); })
    .observe(document.documentElement, { attributes:true, attributeFilter:["data-theme"] });

  document.querySelector(".logo-grid").addEventListener("change", function(e){
    if (e.target.type !== "file" || !e.target.files[0]) return;
    var file = e.target.files[0], v = e.target.closest(".logo-slot").dataset.variant;
    e.target.value = "";
    if (file.size > 2 * 1024 * 1024) return setStatus($("logo-status"), "That file is over 2 MB. Export a smaller version and try again.", "bad");
    setStatus($("logo-status"), "Uploading…");
    fetch("/api/admin/logo/" + v, { method:"POST", headers:{ "Content-Type": file.type || "application/octet-stream" }, body:file })
      .then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || "Upload failed."); return j; }); })
      .then(function(j){
        settings.logos = j.logos; renderLogos();
        var pdfOk = (j.logos.light && /png|jpg/.test(j.logos.light.ext)) || (j.logos.dark && /png|jpg/.test(j.logos.dark.ext));
        setStatus($("logo-status"), "Logo saved." + (pdfOk ? "" : " Upload a PNG or JPG version too if you want it on order PDFs."), "ok");
      })
      .catch(function(err){ setStatus($("logo-status"), err.message, "bad"); });
  });
  document.querySelector(".logo-grid").addEventListener("click", function(e){
    var b = e.target.closest("[data-remove]"); if (!b) return;
    var v = b.closest(".logo-slot").dataset.variant;
    api("/logo/" + v, { method:"DELETE" })
      .then(function(j){ settings.logos = j.logos; renderLogos(); setStatus($("logo-status"), "Logo removed.", "ok"); })
      .catch(function(err){ setStatus($("logo-status"), err.message, "bad"); });
  });
  $("logo-show-name").addEventListener("change", function(){
    api("/settings", { method:"POST", body:{ logoShowName: this.checked } })
      .then(function(s){ settings = s; setStatus($("logo-status"), "Saved.", "ok"); });
  });

  // ---------- orders ----------
  function loadQuotes(){
    api("/quotes").then(function(r){
      var list = r.data || [];
      status.paymentProblem = r.paymentProblem; renderPayProblem();
      $("quote-pay-error").hidden = !r.paymentError;
      $("quote-pay-error").textContent = r.paymentError ? "Couldn\u2019t check payments with Square: " + r.paymentError : "";
      $("quote-summary").textContent = list.length ? list.length + " orders, " + list.filter(function(q){ return q.status === "new"; }).length + " new" : "No orders yet.";
      $("quote-rows").innerHTML = list.map(function(q){
        var em = q.email || {};
        var emailPill = em.customer === "sent" ? '<span class="pill ok">Sent</span>' :
          '<span class="pill ' + (String(em.customer).indexOf("failed") === 0 ? "bad" : "warn") + '" title="' + esc(em.customer || "") + '">' + (String(em.customer).indexOf("failed") === 0 ? "Failed" : "Not sent") + '</span>';
        return '<tr data-id="' + esc(q.id) + '"><td><strong>' + esc(q.id) + '</strong><div class="dm">' + esc(new Date(q.created_at).toLocaleString()) + (q.source === "kiosk" ? ", kiosk" : "") + '</div></td>' +
          '<td>' + esc(q.customer.name) + '<div class="dm"><a href="mailto:' + esc(q.customer.email) + '">' + esc(q.customer.email) + '</a>' + (q.customer.phone ? ", " + esc(q.customer.phone) : "") + '</div>' +
            (q.customer.notes ? '<div class="dm" title="' + esc(q.customer.notes) + '">“' + esc(q.customer.notes.slice(0, 60)) + (q.customer.notes.length > 60 ? "…" : "") + '”</div>' : "") + '</td>' +
          '<td class="dm" style="max-width:260px">' + q.items.map(function(i){ return esc(i.qty + "× " + i.title); }).join("<br>") + '</td>' +
          '<td><strong>' + esc(q.total) + '</strong><div class="dm">' + (q.fulfillment === "ship" ? "Ship" : q.fulfillment === "pickup" ? "Pickup" : "") + '</div></td><td>' + emailPill + '</td>' +
          '<td>' + payCell(q) + '</td>' +
          '<td><select class="input q-status" aria-label="Status">' + ORDER_STATUSES.concat(ORDER_STATUSES.indexOf(q.status) < 0 ? [q.status] : []).map(function(s){
            return '<option' + (s === q.status ? " selected" : "") + '>' + s + '</option>'; }).join("") + '</select></td>' +
          '<td><div class="cell-actions"><a class="btn small" target="_blank" rel="noopener" href="/api/admin/quotes/' + encodeURIComponent(q.id) + '/pdf">PDF</a>' +
          '<button class="btn ghost small" data-resend type="button">Resend</button><span class="saved"></span></div></td></tr>';
      }).join("");
    }).catch(function(e){ $("quote-summary").textContent = e.message; });
  }
  $("quote-rows").addEventListener("change", function(e){
    if (!e.target.classList.contains("q-status")) return;
    var id = e.target.closest("tr").dataset.id;
    api("/quotes/" + encodeURIComponent(id), { method:"POST", body:{ status: e.target.value } }).then(checkNewOrders);
  });
  var ORDER_STATUSES = ["new","printing","ready","shipped","completed","cancelled"];
  function payCell(q){
    var p = q.payment;
    if (p && p.status === "paid") return '<span class="pill ok">Paid</span>' + (p.ship_to ? '<div class="dm ship-to">' + esc(p.ship_to).replace(/\n/g, "<br>") + '</div>' : '');
    if (p && p.url) return '<span class="pill warn">Unpaid</span> <a class="dm" href="' + esc(p.url) + '" target="_blank" rel="noopener">Link</a>';
    var btn = status.square ? '<button class="btn ghost small" data-paylink type="button">Create link</button>' : '';
    return (p && p.error ? '<span class="pill bad">Link failed</span> ' : '<span class="muted">\u2014</span> ') + btn +
      (p && p.error ? '<div class="dm pay-err">' + esc(p.error) + '</div>' : '');
  }
  $("quote-rows").addEventListener("click", function(e){
    var pb = e.target.closest("[data-paylink]");
    if (pb) {
      var row = pb.closest("tr"), msg = row.querySelector(".saved");
      pb.disabled = true; msg.textContent = "Creating link…";
      return api("/quotes/" + encodeURIComponent(row.dataset.id) + "/payment-link", { method:"POST" })
        .then(function(){ msg.textContent = "Link created. Click Resend to email it."; setTimeout(loadQuotes, 2500); })
        .catch(function(err){ msg.textContent = err.message; pb.disabled = false; });
    }
    var b = e.target.closest("[data-resend]"); if (!b) return;
    var tr = b.closest("tr"), note = tr.querySelector(".saved");
    b.disabled = true; note.textContent = "Sending…";
    api("/quotes/" + encodeURIComponent(tr.dataset.id) + "/resend", { method:"POST" })
      .then(function(r){ note.textContent = r.email.customer === "sent" ? "Sent" : r.email.customer; setTimeout(loadQuotes, 1500); })
      .catch(function(err){ note.textContent = err.message; })
      .finally(function(){ b.disabled = false; });
  });

  // ---------- new-order badge and notifications ----------
  var SEEN_KEY = "n3dcat-admin-last-order", orderTimer = null, baseTitle = document.title;
  var canNotify = "Notification" in window && window.isSecureContext;
  var swReg = null;
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin" }).then(function(r){ swReg = r; }).catch(function(){});
    navigator.serviceWorker.addEventListener("message", function(e){ if (e.data && e.data.type === "open-orders") openOrdersTab(); });
  }
  function openOrdersTab(){ document.querySelector('[data-tab="quotes"]').click(); }
  function lastSeen(){ try { return localStorage.getItem(SEEN_KEY); } catch(e){ return null; } }
  function setLastSeen(v){ try { localStorage.setItem(SEEN_KEY, v); } catch(e){} }

  function renderNotifyControls(){
    var btn = $("notify-on"), note = $("notify-note");
    if (!canNotify) {
      btn.hidden = true; note.hidden = false;
      note.textContent = window.isSecureContext ? "This browser doesn\u2019t support notifications. The red count on the Orders tab still updates."
        : "Browser notifications need the admin opened over HTTPS. The red count on the Orders tab still updates.";
      return;
    }
    btn.hidden = Notification.permission !== "default";
    note.hidden = Notification.permission !== "denied";
    note.textContent = "Notifications are blocked for this site. Allow them in your browser\u2019s site settings to get new-order alerts.";
  }
  $("notify-on").addEventListener("click", function(){
    Notification.requestPermission().then(function(p){
      renderNotifyControls();
      if (p === "granted") notify("Notifications are on", "You\u2019ll get an alert here when a new order comes in.", "test");
    });
  });

  function notify(title, body, tag){
    if (!canNotify || Notification.permission !== "granted") return;
    var opts = { body: body, tag: tag, icon: "/admin/assets/icon-192.png", badge: "/admin/assets/icon-192.png" };
    // Android Chrome only allows notifications from a service worker
    if (swReg && swReg.showNotification) return swReg.showNotification(title, opts).catch(function(){});
    try {
      var n = new Notification(title, opts);
      n.onclick = function(){ window.focus(); openOrdersTab(); n.close(); };
    } catch(e){}
  }

  function checkNewOrders(){
    return api("/orders/new").then(function(r){
      var badge = $("orders-badge");
      badge.hidden = !r.count;
      badge.textContent = r.count > 99 ? "99+" : r.count;
      badge.setAttribute("aria-label", r.count + " new orders");
      document.title = (r.count ? "(" + r.count + ") " : "") + baseTitle;
      if (navigator.setAppBadge) (r.count ? navigator.setAppBadge(r.count) : navigator.clearAppBadge()).catch(function(){});

      var seen = lastSeen(), newest = r.orders.length ? r.orders[0].created_at : null;
      if (!seen) { setLastSeen(newest || new Date().toISOString()); return; } // first run: don't alert for old orders
      var fresh = r.orders.filter(function(o){ return o.created_at > seen; });
      if (!fresh.length) return;
      setLastSeen(fresh[0].created_at);
      if (fresh.length === 1) {
        var o = fresh[0];
        notify("New order " + o.id, o.name + " \u2014 " + o.total + (o.fulfillment === "ship" ? ", ship" : o.fulfillment === "pickup" ? ", pickup" : ""), o.id);
      } else {
        notify(fresh.length + " new orders", fresh.map(function(o){ return o.name + " (" + o.total + ")"; }).join(", "), "orders");
      }
      if (!$("quote-rows").closest("[data-panel]").hidden) loadQuotes();
    }).catch(function(){});
  }
  function startOrderWatch(){
    stopOrderWatch(); renderNotifyControls(); checkNewOrders();
    orderTimer = setInterval(checkNewOrders, 30000);
  }
  function stopOrderWatch(){ if (orderTimer) clearInterval(orderTimer); orderTimer = null; }
  // check right away when the tab comes back into view instead of waiting for the next tick
  document.addEventListener("visibilitychange", function(){ if (!document.hidden && orderTimer) checkNewOrders(); });

  // ---------- inventory / spoolman ----------
  var spInited = false;
  function initInventory(){
    $("sp-low").value = settings.spoolmanLowStockGrams;
    $("sp-match").value = settings.spoolmanMatchThreshold;
    $("sp-conn").textContent = status.spoolman ? "SPOOLMAN_URL is set." : "SPOOLMAN_URL isn't set. Add it to the stack's environment variables and redeploy.";
    $("sp-test").disabled = $("sp-check").disabled = !status.spoolman;
    if (spInited) return;
    spInited = true;
    api("/spoolman/report").then(function(r){ if (r.report) renderInventory(r.report); });
  }
  $("sp-test").addEventListener("click", function(){
    setStatus($("sp-conn-status"), "Connecting to Spoolman…");
    api("/spoolman/test").then(function(r){
      setStatus($("sp-conn-status"), "Connected" + (r.info && r.info.version ? " — Spoolman v" + r.info.version : "") + ".", "ok");
    }).catch(function(e){ setStatus($("sp-conn-status"), e.message, "bad"); });
  });
  $("sp-settings-form").addEventListener("submit", function(e){
    e.preventDefault();
    api("/settings", { method:"POST", body:{ spoolmanLowStockGrams: $("sp-low").value, spoolmanMatchThreshold: $("sp-match").value } })
      .then(function(s){ settings = s; setStatus($("sp-settings-status"), "Saved.", "ok"); })
      .catch(function(err){ setStatus($("sp-settings-status"), err.message, "bad"); });
  });
  $("sp-check").addEventListener("click", function(){
    $("sp-check").disabled = true;
    setStatus($("sp-status"), "Pulling spools from Spoolman and matching colors…");
    api("/spoolman/check", { method:"POST" })
      .then(function(r){ renderInventory(r.report); setStatus($("sp-status"), "Done.", "ok"); })
      .catch(function(e){ setStatus($("sp-status"), e.message, "bad"); })
      .finally(function(){ $("sp-check").disabled = !status.spoolman; });
  });
  function renderInventory(report){
    var when = new Date(report.generatedAt).toLocaleString();
    $("sp-summary").textContent = report.toBuy
      ? report.toBuy + " of " + report.rows.length + " colors need attention — checked " + when + " against " + report.spoolCount + " spools."
      : "Every color your designs use is in stock — checked " + when + " against " + report.spoolCount + " spools.";
    $("sp-rows").innerHTML = report.rows.map(function(r){
      var statusPill = r.status === "missing" ? '<span class="pill bad">Buy — not stocked</span>'
        : r.status === "low" ? '<span class="pill warn">Buy — running low</span>'
        : '<span class="pill ok">In stock</span>';
      var match = r.matched
        ? '<div class="match-cell"><span class="swatch-sm" style="background:' + esc(r.matchHex) + '"></span>' + esc(r.matchName || r.matchHex) +
          (r.matchVendor ? ' <span class="muted">(' + esc(r.matchVendor) + ')</span>' : '') + '</div>'
        : '<span class="muted">No close match in Spoolman</span>';
      var designs = r.designs.slice(0, 3).join(", ") + (r.designs.length > 3 ? " +" + (r.designs.length - 3) + " more" : "");
      return '<tr><td><span class="swatch-lg" style="background:' + esc(r.hex) + '"></span></td>' +
        '<td><div class="color-cell"><div><div class="name">' + esc(r.name) + '</div><div class="hex">' + esc(r.hex) + '</div></div></div></td>' +
        '<td class="designs-cell" title="' + esc(r.designs.join(", ")) + '">' + r.designCount + ' design' + (r.designCount === 1 ? "" : "s") + '<br>' + esc(designs) + '</td>' +
        '<td>' + match + '</td>' +
        '<td>' + (r.matched ? (r.matchGrams + ' g' + (r.matchSpools > 1 ? ' across ' + r.matchSpools + ' spools' : '')) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + statusPill + '</td></tr>';
    }).join("") || '<tr><td colspan="6" class="muted">No designs with filament data yet — sync from N3D first.</td></tr>';
  }

  // ---------- square ----------
  var sqLocLoaded = false;
  function renderPayProblem(){
    var msg = status.paymentProblem || "";
    [["pay-problem", ' <a href="#" data-goto-square>Open the Square tab</a> to fix it, then use \u201cCreate link\u201d and \u201cResend\u201d on the orders below.'], ["sq-pay-problem", ""]].forEach(function(x){
      var el = $(x[0]); el.hidden = !msg;
      el.innerHTML = msg ? '<strong>Customers can\u2019t pay online right now.</strong> ' + esc(msg) + x[1] : "";
    });
  }
  function refreshPayProblem(){ return api("/status").then(function(s){ status = s; renderPayProblem(); }); }
  document.addEventListener("click", function(e){
    if (!e.target.closest("[data-goto-square]")) return;
    e.preventDefault(); document.querySelector('[data-tab="square"]').click();
  });
  $("sq-pay-test").addEventListener("click", function(){
    var b = this; b.disabled = true;
    setStatus($("sq-pay-status"), "Asking Square for a $1 test link\u2026");
    api("/square/test-payment-link", { method:"POST" })
      .then(function(){ setStatus($("sq-pay-status"), "Square created a test payment link (and it was deleted again). Payments are ready" + (settings.squarePaymentLinks ? "." : " once you turn on \u201cTake payment at checkout\u201d and save."), "ok"); })
      .catch(function(err){ setStatus($("sq-pay-status"), "Square refused: " + err.message, "bad"); })
      .finally(function(){ b.disabled = !status.square; refreshPayProblem(); });
  });
  function initSquarePay(){
    $("sq-pay-on").checked = !!settings.squarePaymentLinks;
    $("sq-pay-on").disabled = $("sq-pay-test").disabled = !status.square;
    renderApplePay();
    renderPayProblem();
    if (sqLocLoaded || !status.square) return;
    sqLocLoaded = true;
    api("/square/test").then(function(r){
      $("sq-location").innerHTML = '<option value="">First active location</option>' + r.locations.map(function(l){
        return '<option value="' + esc(l.id) + '"' + (l.id === settings.squareLocationId ? " selected" : "") + '>' + esc(l.name) + (l.status === "ACTIVE" ? "" : " (inactive)") + '</option>';
      }).join("");
    }).catch(function(e){ sqLocLoaded = false; setStatus($("sq-pay-status"), e.message, "bad"); });
  }
  // ---------- Apple Pay domain verification file ----------
  var AP_PATH = "/.well-known/apple-developer-merchantid-domain-association";
  function renderApplePay(){
    $("ap-url").href = AP_PATH; $("ap-url").textContent = location.origin + AP_PATH;
    $("ap-state").innerHTML = status.applePayFile ? '<span class="pill ok">Uploaded</span> Apple can fetch it now.' : '<span class="pill warn">Not uploaded</span>';
    $("ap-remove").hidden = !status.applePayFile;
  }
  $("ap-file").addEventListener("change", function(){
    var f = this.files[0]; this.value = ""; if (!f) return;
    setStatus($("ap-status"), "Uploading\u2026");
    fetch("/api/admin/apple-pay-file", { method:"POST", headers:{ "Content-Type":"application/octet-stream" }, body:f })
      .then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || "Upload failed."); }); })
      .then(function(){ status.applePayFile = true; renderApplePay(); setStatus($("ap-status"), "Saved. Now click Verify in Square or Apple.", "ok"); })
      .catch(function(err){ setStatus($("ap-status"), err.message, "bad"); });
  });
  $("ap-remove").addEventListener("click", function(){
    if (!confirm("Remove the Apple Pay verification file?")) return;
    api("/apple-pay-file", { method:"DELETE" })
      .then(function(){ status.applePayFile = false; renderApplePay(); setStatus($("ap-status"), "Removed.", "ok"); })
      .catch(function(err){ setStatus($("ap-status"), err.message, "bad"); });
  });

  // both save as soon as they change, like the other switches in admin
  function saveSquarePay(body, revert){
    setStatus($("sq-pay-status"), "Saving\u2026");
    api("/settings", { method:"POST", body: body })
      .then(function(s){ settings = s; setStatus($("sq-pay-status"), "Saved.", "ok"); return refreshPayProblem(); })
      .catch(function(err){ revert(); setStatus($("sq-pay-status"), "Not saved: " + err.message, "bad"); });
  }
  $("sq-pay-on").addEventListener("change", function(){
    var box = this;
    saveSquarePay({ squarePaymentLinks: box.checked }, function(){ box.checked = !box.checked; });
  });
  $("sq-location").addEventListener("change", function(){
    var sel = this;
    saveSquarePay({ squareLocationId: sel.value }, function(){ sel.value = settings.squareLocationId || ""; });
  });
  $("sq-test").addEventListener("click", function(){
    setStatus($("sq-locations"), "Connecting to Square…");
    api("/square/test").then(function(r){
      setStatus($("sq-locations"), "Connected. Locations: " + (r.locations.map(function(l){ return l.name + " (" + l.status.toLowerCase() + ")"; }).join(", ") || "none found"), "ok");
    }).catch(function(e){ setStatus($("sq-locations"), e.message, "bad"); });
  });
  $("sq-overwrite").addEventListener("change", function(){
    api("/settings", { method:"POST", body:{ squareOverwritePrices: this.checked } }).then(function(s){ settings = s; });
  });
  $("sq-push-all").addEventListener("click", function(){
    var n = designs.filter(function(d){ return $("sq-hidden").checked || d.visible !== false; }).length;
    if (!confirm("Push " + n + " designs to Square? Existing items are updated, new ones are created.")) return;
    api("/square/push-all", { method:"POST", body:{ includeHidden: $("sq-hidden").checked } })
      .then(checkSquareJob).catch(function(e){ setStatus($("sq-status"), e.message, "bad"); });
  });
  // ---------- duplicate cleanup ----------
  var dupCount = 0;
  $("sq-dups-find").addEventListener("click", function(){
    var b = this; b.disabled = true; $("sq-dups-delete").hidden = true;
    setStatus($("sq-dups-status"), "Looking through your Square catalog\u2026");
    api("/square/duplicates").then(function(r){
      dupCount = r.count;
      if (!r.count) return setStatus($("sq-dups-status"), "No duplicates found.", "ok");
      var names = {}; r.items.forEach(function(x){ names[x.name] = (names[x.name] || 0) + 1; });
      setStatus($("sq-dups-status"), r.count + " extra " + (r.count === 1 ? "copy" : "copies") + " of " + Object.keys(names).length + " designs: " +
        Object.keys(names).slice(0, 8).map(function(n){ return n + " (" + names[n] + ")"; }).join(", ") + (Object.keys(names).length > 8 ? ", \u2026" : ""));
      $("sq-dups-delete").hidden = false;
      $("sq-dups-delete").textContent = "Delete " + r.count + " duplicate" + (r.count === 1 ? "" : "s");
    }).catch(function(e){ setStatus($("sq-dups-status"), e.message, "bad"); })
      .finally(function(){ b.disabled = false; });
  });
  $("sq-dups-delete").addEventListener("click", function(){
    if (!confirm("Delete " + dupCount + " duplicate items from your Square catalog? The copy each design is linked to is kept. This can't be undone.")) return;
    var b = this; b.disabled = true;
    setStatus($("sq-dups-status"), "Deleting\u2026");
    api("/square/duplicates/delete", { method:"POST" })
      .then(function(r){ setStatus($("sq-dups-status"), "Deleted " + r.deleted + " duplicate" + (r.deleted === 1 ? "" : "s") + ".", "ok"); b.hidden = true; })
      .catch(function(e){ setStatus($("sq-dups-status"), e.message, "bad"); })
      .finally(function(){ b.disabled = false; });
  });

  var pollTimer;
  function checkSquareJob(){
    clearTimeout(pollTimer);
    api("/square/status").then(function(j){
      if (!j.startedAt) return;
      $("sq-progress").hidden = false;
      $("sq-bar").style.width = (j.total ? Math.round(j.done / j.total * 100) : 100) + "%";
      $("sq-push-all").disabled = j.running || !status.square;
      if (j.running) {
        setStatus($("sq-status"), "Pushing " + j.done + " of " + j.total + "…");
        pollTimer = setTimeout(checkSquareJob, 1500);
      } else {
        setStatus($("sq-status"), "Finished: " + (j.done - j.failed) + " pushed" + (j.failed ? ", " + j.failed + " failed." : "."), j.failed ? "bad" : "ok");
        loadDesigns();
      }
      $("sq-errors").innerHTML = j.errors.map(function(x){ return "<li>" + esc(x.slug) + ": " + esc(x.error) + "</li>"; }).join("");
    });
  }
})();
