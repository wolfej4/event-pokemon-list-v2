(function(){
  "use strict";
  // Order confirmation page. Square sends customers here after paying:
  // /order/<id>?t=<token>. Without the token (older links) it can only say thanks.
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function safeUrl(u){ return /^https?:\/\//i.test(u || "") ? u : ""; }

  var id = decodeURIComponent(location.pathname.split("/")[2] || "");
  var token = new URLSearchParams(location.search).get("t") || "";
  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_WAIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  fetch("/api/public/settings").then(function(r){ return r.json(); }).then(function(s){
    var name = s.businessName || "Design Catalog";
    $("brand").textContent = name;
    document.title = "Your order — " + name;
    var logo = s.logo;
    if (logo && logo.light) {
      var light = $("logo-light"), dark = $("logo-dark"), distinct = logo.dark !== logo.light;
      light.src = logo.light; dark.src = logo.dark; light.alt = dark.alt = name;
      light.hidden = false; dark.hidden = !distinct;
      light.classList.toggle("has-dark", distinct); dark.classList.toggle("has-light", distinct);
      if (s.logoShowName === false) { $("brand").classList.add("sr-only"); light.alt = dark.alt = ""; }
    }
  }).catch(function(){});

  function head(ok, title, sub){
    return '<div class="order-icon ' + (ok ? "ok" : "wait") + '">' + (ok ? ICON_OK : ICON_WAIT) + '</div>' +
      '<h1>' + esc(title) + '</h1><p class="order-sub">' + sub + '</p>';
  }
  function nextStep(o){
    if (o.fulfillment === "ship") {
      return '<div class="order-next"><h2>Shipping to</h2>' +
        (o.ship_to ? '<p class="addr">' + esc(o.ship_to).replace(/\n/g, "<br>") + '</p>' : '<p>The address you entered at checkout.</p>') +
        '<p>Every piece is printed to order. We’ll email <strong>' + esc(o.email) + '</strong> when it ships.</p></div>';
    }
    if (o.fulfillment === "pickup") {
      return '<div class="order-next"><h2>Local pickup</h2><p>Every piece is printed to order. We’ll email <strong>' + esc(o.email) + '</strong> when it’s ready to pick up.</p></div>';
    }
    return '<div class="order-next"><p>We’ll email <strong>' + esc(o.email) + '</strong> with updates on your order.</p></div>';
  }
  function summary(o){
    return '<div class="order-lines">' + o.items.map(function(i){
      return '<div class="ol"><span>' + esc(i.qty) + ' × ' + esc(i.title) + '</span><span>' + esc(i.total) + '</span></div>';
    }).join("") +
      (o.subtotal && o.shipping ? '<div class="ol sub"><span>Subtotal</span><span>' + esc(o.subtotal) + '</span></div><div class="ol sub"><span>Shipping</span><span>' + esc(o.shipping) + '</span></div>' : '') +
      '<div class="ol total"><span>Total</span><span>' + esc(o.total) + '</span></div></div>';
  }
  function footer(o){
    return '<div class="order-actions"><a class="btn" href="' + esc(o.pdf_url) + '" target="_blank" rel="noopener">Order summary (PDF)</a>' +
      '<a class="btn primary" href="/">Keep shopping</a></div>' +
      (o.business_email ? '<p class="fine order-help">Questions? Email <a href="mailto:' + esc(o.business_email) + '">' + esc(o.business_email) + '</a> and mention order ' + esc(o.id) + '.</p>' : '');
  }

  function render(o, stillChecking){
    var h;
    if (o.paid) {
      h = head(true, "Thanks, " + o.name.split(" ")[0] + "! Your order is paid.", "Order <strong>" + esc(o.id) + "</strong>. Square is emailing your receipt.") + nextStep(o) + summary(o) + footer(o);
    } else if (stillChecking) {
      h = head(false, "Confirming your payment…", "Order <strong>" + esc(o.id) + "</strong>. This usually takes a few seconds.") + summary(o);
    } else {
      var pay = safeUrl(o.pay_url);
      h = head(false, "We haven’t received payment yet", "Order <strong>" + esc(o.id) + "</strong> is saved. " +
        (pay ? "If you already paid, it can take a minute to show up here. Otherwise you can finish paying now." : "If you already paid, it can take a minute to show up here. Refresh to check again.")) +
        (pay ? '<div class="order-actions"><a class="btn primary pay" href="' + esc(pay) + '">Pay ' + esc(o.total) + '</a></div>' : '') +
        summary(o) + footer(o);
    }
    $("order").innerHTML = h;
  }

  // older payment links (and anyone without the link) only get a general thank-you
  if (!token) {
    $("order").innerHTML = head(true, "Thanks for your order!", (id ? "Order <strong>" + esc(id) + "</strong>. " : "") +
      "If you completed payment, Square has emailed your receipt. We’ll email you when your order ships or is ready for pickup.") +
      '<div class="order-actions"><a class="btn primary" href="/">Keep shopping</a></div>';
    return;
  }

  var tries = 0;
  function load(){
    fetch("/api/public/orders/" + encodeURIComponent(id) + "?t=" + encodeURIComponent(token))
      .then(function(r){ if (r.status === 404) throw new Error("missing"); if (!r.ok) throw new Error("server"); return r.json(); })
      .then(function(o){
        // Square can take a moment to mark the order paid after the redirect
        var checking = !o.paid && tries < 5;
        render(o, checking);
        if (checking) { tries++; setTimeout(load, 2500); }
      })
      .catch(function(e){
        $("order").innerHTML = head(false, e.message === "missing" ? "We couldn’t find that order" : "Something went wrong",
          e.message === "missing" ? "Check the link in your confirmation email." : "Refresh the page to try again.") +
          '<div class="order-actions"><a class="btn primary" href="/">Keep shopping</a></div>';
      });
  }
  load();
})();
